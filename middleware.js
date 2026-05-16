import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/*
 * Middleware that:
 *   1. Refreshes the Supabase session cookie on every request.
 *   2. Gates protected API routes on authentication.
 *
 * Public routes: /, /sign-in, /sign-up, /api/auth/*, static assets.
 * Everything else that starts with /api/ requires a Supabase session.
 */
export async function middleware(req) {
  const res = NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return res;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      get: (name) => req.cookies.get(name)?.value,
      set: (name, value, options) => {
        res.cookies.set({ name, value, ...options });
      },
      remove: (name, options) => {
        res.cookies.set({ name, value: '', ...options, maxAge: 0 });
      },
    },
  });

  // Touches the session so it auto-refreshes if near expiry.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Gate the private API routes. Note:
  //   - /api/checkout is not here — subscription path supports
  //     anonymous users (pay first, sign up after).
  //   - /api/upload-token is not here — anonymous visitors on the
  //     face-swap page need to upload before hitting the paywall.
  //     The route returns short-lived Blob tokens with size caps
  //     enforced upstream.
  const privateApiPrefixes = [
    '/api/character-frame',
    '/api/swap',
    '/api/status',
    '/api/entitlement',
    '/api/extract-frame',
    '/api/image-to-video',
    '/api/ugc-image',
    '/api/ugc-animate',
    '/api/signup-ip',
    '/api/video',
    '/api/history',
    '/api/admin',
  ];
  if (privateApiPrefixes.some((p) => pathname.startsWith(p))) {
    if (!user) {
      return new NextResponse(
        JSON.stringify({ error: 'Authentication required.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Protected pages \u2014 redirect anonymous users to sign-in.
  // /ugc and /video/editing are intentionally NOT here: they're
  // marketing-style landings for anonymous visitors that gate inline
  // at the CTA click (sign-up after the user shows intent), mirroring
  // how / works for face-swap.
  const protectedPages = ['/dashboard', '/image-to-video', '/history', '/admin', '/topup'];
  if (protectedPages.some((p) => pathname.startsWith(p)) && !user) {
    const redirect = req.nextUrl.clone();
    redirect.pathname = '/sign-in';
    return NextResponse.redirect(redirect);
  }

  return res;
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/image-to-video/:path*',
    '/video/editing/:path*',
    '/api/character-frame/:path*',
    '/api/swap/:path*',
    '/api/status/:path*',
    '/api/entitlement/:path*',
    '/api/extract-frame/:path*',
    '/api/image-to-video/:path*',
    '/api/ugc-image/:path*',
    '/api/ugc-animate/:path*',
    '/api/signup-ip/:path*',
    '/api/video/:path*',
    '/api/history/:path*',
    '/history/:path*',
    '/api/admin/:path*',
    '/admin/:path*',
    '/topup',
  ],
};
