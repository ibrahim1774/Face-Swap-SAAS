import { useEffect } from 'react';
import { useRouter } from 'next/router';

/*
 * Fires TikTok `ViewContent` on every page load + client-side route
 * change. TikTok's diagnostics flag a SaaS pixel as "missing vertical
 * funnel events" when ViewContent is absent — this completes the
 * funnel (PageView → ViewContent → AddToCart → InitiateCheckout →
 * Purchase).
 *
 * Includes a `contents` array with a `content_id` derived from the
 * path so TikTok's "Content ID is missing" diagnostic stays clear.
 */
function pageContentId(path) {
  if (!path || path === '/') return 'face-swap';
  return path.replace(/^\/+/, '').replace(/\/$/, '') || 'face-swap';
}

export default function TikTokRouteEvents() {
  const router = useRouter();
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const fire = (path) => {
      if (!window.ttq || typeof window.ttq.track !== 'function') return;
      const id = pageContentId(path);
      try {
        window.ttq.track('ViewContent', {
          contents: [
            { content_id: id, content_type: 'product', content_name: id },
          ],
          content_type: 'product',
        });
      } catch {}
    };

    // Fire on initial mount.
    fire(router.pathname);

    const handler = (url) => fire(url.split('?')[0]);
    router.events.on('routeChangeComplete', handler);
    return () => router.events.off('routeChangeComplete', handler);
  }, [router]);

  return null;
}
