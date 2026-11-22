// Vercel entry point. Every request is rewritten here by vercel.json, with the
// original path in `__path`. We restore the path and hand the request to the same
// app that `npm start` runs. The app is created once per warm function instance.
import { createApp } from '../src/server/server.js';

let appPromise = null;
const getApp = () => {
  if (!appPromise) {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not set. Add it in Vercel → Project → Settings → Environment Variables.');
    }
    appPromise = createApp().catch((err) => { appPromise = null; throw err; });
  }
  return appPromise;
};

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const original = url.searchParams.get('__path');
    if (original !== null) {
      url.searchParams.delete('__path');
      const qs = url.searchParams.toString();
      req.url = original + (qs ? `?${qs}` : '');
    }
    const app = await getApp();
    return app.handle(req, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || 'Server not configured' }));
  }
}
