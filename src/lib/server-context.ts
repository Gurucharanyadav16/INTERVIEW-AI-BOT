import { InterviewFlowPlatform } from './workflow/engine.mjs';

let globalPlatform: InterviewFlowPlatform | null = null;

export function getPlatformInstance(): InterviewFlowPlatform {
  if (!globalPlatform) {
    globalPlatform = new InterviewFlowPlatform();
  }
  return globalPlatform;
}

export async function getAuthenticatedActor(req: Request) {
  const role = (req.headers.get('x-actor-role') || 'ADMIN').toUpperCase();
  const id = req.headers.get('x-actor-id') || 'USR-ADMIN-01';
  const candidateId = req.headers.get('x-candidate-id') || undefined;
  return { id, role, candidateId };
}
