require('dotenv').config();
const express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), nodemailer = require('nodemailer'), path = require('path'), crypto = require('crypto');

const E = process.env;
const PORT = Number(E.PORT) || 3000, MAX_RETURNS = Number(E.MAX_RETURNS) || 5, RETURN_DAYS = Number(E.RETURN_DAYS) || 7;
const GROQ_MODEL = E.GROQ_MODEL || 'qwen/qwen3.8-27b', ADMIN_EMAIL = (E.ADMIN_EMAIL || '').trim().toLowerCase();
if (!E.JWT_SECRET) { console.error('Missing JWT_SECRET in .env'); process.exit(1); }
if (!E.GROQ_API_KEY) console.warn('! GROQ_API_KEY not set: disputes will go to manual review.');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, hash TEXT, unblocked_at INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT, category TEXT, price INTEGER, mrp INTEGER, stock INTEGER, emoji TEXT, seller_id TEXT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT, pname TEXT, qty INTEGER, price INTEGER, address TEXT,
  status TEXT DEFAULT 'Placed', created_at INTEGER, delivered_at INTEGER, returned INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS disputes(id TEXT PRIMARY KEY, order_id TEXT, user_id TEXT, fault TEXT, location TEXT, confidence REAL, reasoning TEXT,
  note TEXT, photo TEXT, decided_by TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS mails(id TEXT PRIMARY KEY, user_id TEXT, to_email TEXT, subject TEXT, body TEXT, sent INTEGER DEFAULT 0, created_at INTEGER);
`);

const uid = () => crypto.randomUUID();
const now = () => Date.now();
const isAdmin = u => !!ADMIN_EMAIL && u.email === ADMIN_EMAIL;

/* ---------- seed catalog (set SEED_PRODUCTS=false to start empty) ---------- */
if (E.SEED_PRODUCTS !== 'false' && !db.prepare('SELECT 1 FROM products').get()) {
  const ins = db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,NULL)');
  [['Portable Bluetooth Speaker', 'Electronics', 2999, 4999, 25, '🔊'], ['Mechanical Gaming Keyboard', 'Electronics', 5499, 8999, 20, '⌨️'],
   ['Wireless Noise-Cancelling Headphones', 'Electronics', 7999, 12999, 14, '🎧'], ['Modern Coffee Maker', 'Home & Living', 6499, 9999, 7, '☕'],
   ['Ceramic Table Lamp', 'Home & Living', 1899, 2999, 12, '💡'], ['Classic Backpack', 'Accessories', 2299, 3999, 18, '🎒'],
   ['Smart Fitness Watch', 'Accessories', 3499, 5999, 22, '⌚'], ['Cotton Summer Dress', 'Fashion', 1599, 2799, 30, '👗'],
   ['Running Shoes', 'Sports', 3299, 5499, 16, '👟'], ['Football (Size 5)', 'Sports', 899, 1499, 40, '⚽'],
   ['Vitamin C Face Serum', 'Beauty', 699, 1199, 35, '✨'], ['Bestselling Novel Set', 'Books', 1099, 1799, 28, '📚']]
    .forEach(p => ins.run(uid(), ...p));
}

/* ---------- email ---------- */
const transport = E.SMTP_HOST ? nodemailer.createTransport({
  host: E.SMTP_HOST, port: Number(E.SMTP_PORT) || 587, secure: Number(E.SMTP_PORT) === 465,
  auth: E.SMTP_USER ? { user: E.SMTP_USER, pass: E.SMTP_PASS } : undefined
}) : null;

async function sendMail(user, subject, body) {
  const id = uid();
  db.prepare('INSERT INTO mails(id,user_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(id, user.id, user.email, subject, body, now());
  if (transport) {
    try {
      await transport.sendMail({ from: E.MAIL_FROM || E.SMTP_USER, to: user.email, subject, text: body });
      db.prepare('UPDATE mails SET sent=1 WHERE id=?').run(id);
    } catch (e) { console.error('Email failed:', e.message); }
  }
  return db.prepare('SELECT id,to_email AS "to",subject,body,sent,created_at AS at FROM mails WHERE id=?').get(id);
}

/* ---------- Groq vision analysis ---------- */
const PROMPT = (pname, note) => `You inspect photos of damaged e-commerce parcels to decide who is at fault.
Product: "${pname}". Customer note: "${String(note || '').slice(0, 300)}".
Rules:
- If the outer shipping box / packaging is visibly crushed, torn, dented, punctured or wet -> damage happened in transit -> fault "delivery".
- If the packaging looks intact (or is not shown) and the damage is on the product itself (defect, crack, scratch, missing part, wrong item) -> fault "merchant".
- If the photo does not show a damaged product, is unclear, or the evidence is mixed -> fault "unsure".
Reply with ONLY a JSON object: {"location":"package|product|both|unclear","fault":"delivery|merchant|unsure","confidence":0.0-1.0,"reasoning":"max 2 short sentences"}`;

async function analyzeImage(image, pname, note) {
  const fallback = reason => ({ location: 'unclear', fault: 'unsure', confidence: 0, reasoning: reason });
  if (!E.GROQ_API_KEY) return fallback('AI analysis is not configured, so the case needs manual review.');
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.GROQ_API_KEY },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.2, max_completion_tokens: 2048, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT(pname, note) }, { type: 'image_url', image_url: { url: image } }] }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Groq error ' + res.status);
    let text = String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    const fault = ['delivery', 'merchant'].includes(j.fault) && confidence >= 0.6 ? j.fault : 'unsure';
    return { location: j.location || 'unclear', fault, confidence, reasoning: String(j.reasoning || '').slice(0, 400) };
  } catch (e) {
    console.error('Groq analysis failed:', e.message);
    return fallback('The AI analysis could not be completed, so the case was sent for manual review.');
  }
}

const NEXT = {
  delivery: 'The damage looks like it happened during delivery. A prepaid exchange label has been issued: hand the parcel to the courier and your replacement ships as soon as it is picked up.',
  merchant: 'The damage looks like it came from the seller. You can choose a full refund or a replacement: just reply to this email with your choice. Pickup is arranged at no cost.',
  unsure: 'We could not decide with enough confidence. Your case has been sent to our team for manual review and you will hear back within 48 hours.'
};
const mailBody = (u, o, d) => `Hi ${u.name},

We reviewed the photo you uploaded for "${o.pname}" (order ${o.id}).

Finding: damage appears to be on the ${d.location}. Fault assigned to: ${d.fault === 'unsure' ? 'pending manual review' : d.fault + ' side'} (confidence ${Math.round(d.confidence * 100)}%).
${d.reasoning}

Next step: ${NEXT[d.fault]}

- DamageGuard Support`;

/* ---------- abuse blocking ---------- */
function returnCount(u) {
  return db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=? AND returned=1 AND created_at>=?').get(u.id, u.unblocked_at || 0).c;
}
const isBlocked = u => returnCount(u) > MAX_RETURNS;

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(jwt.verify(t, E.JWT_SECRET).id);
    if (!u) throw 0;
    req.user = u; next();
  } catch { bad(res, 'Please sign in', 401); }
}
const adminOnly = (req, res, next) => isAdmin(req.user) ? next() : bad(res, 'Admins only', 403);
const token = u => jwt.sign({ id: u.id }, E.JWT_SECRET, { expiresIn: '14d' });

app.post('/api/register', wrap((req, res) => {
  const name = String(req.body.name || '').trim(), email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter your name and a valid email.');
  if (pw.length < 6) return bad(res, 'Password must be at least 6 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 'An account with this email already exists.', 409);
  const u = { id: uid(), name, email };
  db.prepare('INSERT INTO users(id,name,email,hash,created_at) VALUES(?,?,?,?,?)').run(u.id, name, email, bcrypt.hashSync(pw, 10), now());
  res.json({ token: token(u) });
}));

app.post('/api/login', wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u) return bad(res, 'No account found for this email.', 401);
  if (!bcrypt.compareSync(String(req.body.password || ''), u.hash)) return bad(res, 'Incorrect password.', 401);
  res.json({ token: token(u) });
}));

app.get('/api/me', auth, wrap((req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, isAdmin: isAdmin(u), returns: returnCount(u), blocked: isBlocked(u), limit: MAX_RETURNS, returnDays: RETURN_DAYS,
    orders: db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=? AND created_at>=?').get(u.id, u.unblocked_at || 0).c });
}));

app.get('/api/products', wrap((req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY rowid').all())));

app.post('/api/products', auth, wrap((req, res) => {
  const b = req.body, price = Math.round(Number(b.price)), mrp = Math.round(Number(b.mrp)) || price, stock = Math.round(Number(b.stock));
  if (!String(b.name || '').trim() || !(price > 0) || !(stock > 0)) return bad(res, 'Fill name, price and stock.');
  db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?)').run(uid(), String(b.name).trim().slice(0, 120), String(b.category || 'Accessories'), price, mrp, stock, b.emoji || null, req.user.id);
  res.json({ ok: true });
}));

app.post('/api/orders', auth, wrap((req, res) => {
  if (isBlocked(req.user)) return bad(res, `Your account is blocked from ordering after more than ${MAX_RETURNS} returns.`, 403);
  const items = Array.isArray(req.body.items) ? req.body.items : [], address = String(req.body.address || '').trim();
  if (!items.length || !address) return bad(res, 'Cart and delivery address are required.');
  try {
    db.transaction(() => {
      for (const it of items) {
        const qty = Math.round(Number(it.qty)), p = db.prepare('SELECT * FROM products WHERE id=?').get(it.id);
        if (!p || !(qty > 0)) throw new Error('Invalid item.');
        if (p.stock < qty) throw new Error(`Only ${p.stock} left of ${p.name}.`);
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
        db.prepare('INSERT INTO orders(id,user_id,product_id,pname,qty,price,address,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(uid(), req.user.id, p.id, p.name, qty, p.price * qty, address, now());
      }
    })();
    res.json({ ok: true });
  } catch (e) { bad(res, e.message); }
}));

const orderWithDispute = o => ({ ...o, dispute: db.prepare('SELECT * FROM disputes WHERE order_id=?').get(o.id) || null });
app.get('/api/orders', auth, wrap((req, res) =>
  res.json(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(req.user.id).map(orderWithDispute))));

app.post('/api/orders/:id/deliver', auth, wrap((req, res) => {
  const r = db.prepare("UPDATE orders SET status='Delivered', delivered_at=? WHERE id=? AND user_id=? AND status='Placed'").run(now(), req.params.id, req.user.id);
  r.changes ? res.json({ ok: true }) : bad(res, 'Order cannot be marked as delivered.');
}));

app.post('/api/disputes', auth, wrap(async (req, res) => {
  const u = req.user, o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.body.orderId, u.id);
  const image = String(req.body.image || '');
  if (!o) return bad(res, 'Order not found.', 404);
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image)) return bad(res, 'Upload a JPG, PNG or WebP photo.');
  if (o.status !== 'Delivered') return bad(res, 'You can report damage only after the order is delivered.');
  if (o.returned) return bad(res, 'A dispute was already opened for this order.');
  if (now() - o.delivered_at > RETURN_DAYS * 864e5) return bad(res, `The ${RETURN_DAYS}-day return window has closed.`);

  const d = await analyzeImage(image, o.pname, req.body.note);
  const did = uid();
  db.prepare('INSERT INTO disputes VALUES(?,?,?,?,?,?,?,?,?,NULL,?)')
    .run(did, o.id, u.id, d.fault, d.location, d.confidence, d.reasoning, String(req.body.note || '').slice(0, 300), image, now());
  db.prepare('UPDATE orders SET returned=1, status=? WHERE id=?').run(d.fault === 'unsure' ? 'Manual review' : 'Return approved', o.id);
  const mail = await sendMail(u, `DamageGuard: update on your return for ${o.pname}`, mailBody(u, o, d));
  res.json({ dispute: { id: did, ...d }, outcome: NEXT[d.fault], mail, blocked: isBlocked(u), returns: returnCount(u), limit: MAX_RETURNS });
}));

app.get('/api/mails', auth, wrap((req, res) =>
  res.json(db.prepare('SELECT id,to_email AS "to",subject,body,sent,created_at AS at FROM mails WHERE user_id=? ORDER BY created_at DESC').all(req.user.id))));

/* ---------- admin ---------- */
app.get('/api/admin/overview', auth, adminOnly, wrap((req, res) => {
  const users = db.prepare('SELECT * FROM users').all();
  res.json({
    queue: db.prepare(`SELECT d.*, o.pname, u.name, u.email FROM disputes d JOIN orders o ON o.id=d.order_id JOIN users u ON u.id=d.user_id
      WHERE o.status='Manual review' ORDER BY d.created_at`).all(),
    blocked: users.filter(isBlocked).map(u => ({ id: u.id, name: u.name, email: u.email, returns: returnCount(u) })),
    disputes: db.prepare(`SELECT d.id,d.fault,d.confidence,d.created_at,d.decided_by,o.pname,u.email FROM disputes d JOIN orders o ON o.id=d.order_id
      JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 100`).all()
  });
}));

app.post('/api/admin/disputes/:id/resolve', auth, adminOnly, wrap(async (req, res) => {
  const fault = req.body.fault;
  if (!['delivery', 'merchant'].includes(fault)) return bad(res, 'Invalid fault.');
  const d = db.prepare('SELECT * FROM disputes WHERE id=?').get(req.params.id);
  if (!d) return bad(res, 'Not found.', 404);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(d.order_id), u = db.prepare('SELECT * FROM users WHERE id=?').get(d.user_id);
  const reasoning = (d.reasoning + ' Confirmed by manual review.').trim();
  db.prepare("UPDATE disputes SET fault=?, confidence=1, reasoning=?, decided_by='admin' WHERE id=?").run(fault, reasoning, d.id);
  db.prepare("UPDATE orders SET status='Return approved' WHERE id=?").run(o.id);
  await sendMail(u, `DamageGuard: review decision for ${o.pname}`, mailBody(u, o, { ...d, fault, confidence: 1, reasoning }));
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/unblock', auth, adminOnly, wrap((req, res) => {
  db.prepare('UPDATE users SET unblocked_at=? WHERE id=?').run(now(), req.params.id);
  res.json({ ok: true });
}));

app.listen(PORT, () => console.log(`DamageGuard running on http://localhost:${PORT}  (model: ${GROQ_MODEL}, email: ${transport ? 'SMTP on' : 'in-app only'})`));
