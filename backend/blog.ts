import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const PUBLICATION_URL = 'https://projectmartian.substack.com';
const PAGE_SIZE = 20;
const CACHE_MS = 5 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;

const publicUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
});
const articleUrl = publicUrl.refine(value => {
  const url = new URL(value);
  return url.origin === PUBLICATION_URL && url.pathname.startsWith('/p/');
});
const archiveSchema = z.array(z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1).max(1000),
  subtitle: z.string().max(10000).nullish(),
  canonical_url: articleUrl,
  post_date: z.iso.datetime({ offset: true }),
  cover_image: publicUrl.nullish(),
})).max(PAGE_SIZE);
const querySchema = z.object({
  offset: z.string().regex(/^(0|[1-9][0-9]*)$/).default('0')
    .transform(Number).refine(value => Number.isSafeInteger(value) && value % PAGE_SIZE === 0),
}).strict();

async function fetchPage(offset: number) {
  const url = new URL('/api/v1/archive', PUBLICATION_URL);
  url.search = new URLSearchParams({ sort: 'new', offset: String(offset), limit: String(PAGE_SIZE) }).toString();
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('Substack archive unavailable');
  }
  if (!response.body) throw new Error('Substack archive body missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Substack archive exceeds size limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const posts = archiveSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  return {
    publication_url: PUBLICATION_URL,
    fetched_at: new Date().toISOString(),
    posts: posts.map(post => ({
      id: post.id,
      title: post.title,
      subtitle: post.subtitle ?? null,
      url: post.canonical_url,
      published_at: post.post_date,
      image_url: post.cover_image ?? null,
    })),
    next_offset: posts.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  };
}

export function registerBlog(app: FastifyInstance) {
  type Page = Awaited<ReturnType<typeof fetchPage>>;
  const cache = new Map<number, { expires: number; page: Page }>();
  const pending = new Map<number, Promise<Page>>();

  app.get('/api/blog', async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ detail: 'Use a non-negative offset in multiples of 20.' });
    const { offset } = query.data;
    const entry = cache.get(offset);
    if (entry && entry.expires > Date.now()) return entry.page;
    cache.delete(offset);
    let task = pending.get(offset);
    if (!task) {
      if (pending.size >= 4) return reply.code(429).send({ detail: 'The blog is busy. Please try again shortly.' });
      task = fetchPage(offset).then(page => {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(offset, { expires: Date.now() + CACHE_MS, page });
        return page;
      }).finally(() => { pending.delete(offset); });
      pending.set(offset, task);
    }
    try { return await task; }
    catch { return reply.code(502).send({ detail: 'Substack posts are unavailable right now.' }); }
  });
}
