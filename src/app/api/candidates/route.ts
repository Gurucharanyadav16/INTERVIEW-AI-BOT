import { NextRequest, NextResponse } from 'next/server';
import { getPlatformInstance, getAuthenticatedActor } from '@/lib/server-context';

export async function GET(req: NextRequest) {
  try {
    const actor = await getAuthenticatedActor(req);
    const { searchParams } = new URL(req.url);
    const platform = getPlatformInstance();
    const result = platform.queryCandidates(actor, {
      search: searchParams.get('search') || '',
      status: searchParams.get('status') || '',
      role: searchParams.get('role') || '',
      page: Number(searchParams.get('page') || 1),
      pageSize: Number(searchParams.get('pageSize') || 10),
    });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'FORBIDDEN' ? 403 : 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await getAuthenticatedActor(req);
    const body = await req.json();
    const platform = getPlatformInstance();
    const result = platform.importCandidates(actor, body.rows || [], body.format || 'CSV');
    return NextResponse.json(result, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
}
