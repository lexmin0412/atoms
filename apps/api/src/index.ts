import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config';
import { authRoutes } from './routes/auth';
import { projectRoutes } from './routes/projects';
import { chatRoutes } from './routes/chat';
import { usageRoutes } from './routes/usage';
import { shareRoutes } from './routes/share';

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/projects', chatRoutes);
app.route('/api/usage', usageRoutes);
app.route('/share', shareRoutes);

serve(
  { fetch: app.fetch, port: config.apiPort, hostname: '127.0.0.1' },
  (info) => {
    console.log(`[api] listening on http://127.0.0.1:${info.port}`);
  },
);
