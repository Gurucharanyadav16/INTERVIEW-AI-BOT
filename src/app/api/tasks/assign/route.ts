import { NextRequest, NextResponse } from 'next/server';
import { getPlatformInstance, getAuthenticatedActor } from '@/lib/server-context';

export async function POST(req: NextRequest) {
  try {
    const actor = await getAuthenticatedActor(req);
    const body = await req.json();
    const platform = getPlatformInstance();
    const assignment = platform.assignTaskToCandidate(actor, body.candidateId, body.options || {});
    return NextResponse.json(assignment, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
}
