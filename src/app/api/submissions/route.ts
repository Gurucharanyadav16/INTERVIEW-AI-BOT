import { NextRequest, NextResponse } from 'next/server';
import { getPlatformInstance, getAuthenticatedActor } from '@/lib/server-context';

export async function POST(req: NextRequest) {
  try {
    const actor = await getAuthenticatedActor(req);
    const body = await req.json();
    const platform = getPlatformInstance();
    const review = platform.submitRepositoryAndReview(actor, body);
    return NextResponse.json(review, { status: 201 });
  } catch (err: any) {
    const status = err.code?.startsWith('FORBIDDEN') ? 403 : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
}
