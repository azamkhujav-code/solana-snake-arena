import { NextResponse } from 'next/server';

// Container health probe. Static so it never touches a downstream service —
// the web tier being up is independent of the gateway being up.
export const dynamic = 'force-static';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'web',
    version: process.env.GIT_SHA ?? 'unknown',
  });
}
