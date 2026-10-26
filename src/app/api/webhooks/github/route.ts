import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getPlatformInstance } from '@/lib/server-context';

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-hub-signature-256') || '';
  const rawBody = await req.text();
  const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
  if (!secret) {
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 503 });
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
  }
  const payload = JSON.parse(rawBody);
  const platform = getPlatformInstance();
  return NextResponse.json({ status: 'accepted', commitSha: payload.after });
}
