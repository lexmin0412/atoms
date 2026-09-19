import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { config } from './config';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { creditRoutes } from './routes/credits';
import { dbRoutes } from './routes/db';
import { projectRoutes } from './routes/projects';

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api/auth', authRoutes);
app.route('/api/credits', creditRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/projects', chatRoutes);
app.route('/api/projects', dbRoutes);

serve({ fetch: app.fetch, port: config.apiPort, hostname: '127.0.0.1' }, (info) => {
  console.log(`[api] listening on http://127.0.0.1:${info.port}`);
});
