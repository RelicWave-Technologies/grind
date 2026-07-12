import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import IdlePrompt from './IdlePrompt';
import AwayPrompt from './AwayPrompt';
import PermissionPrompt from './PermissionPrompt';

export default function AttentionPrompt() {
  const qc = useQueryClient();
  const prompt = useQuery({
    queryKey: ['attentionPrompt'],
    queryFn: () => window.agent.attention.get(),
    staleTime: 0,
  });

  useEffect(() => window.agent.attention.onChange((next) => {
    qc.setQueryData(['attentionPrompt'], next);
  }), [qc]);

  if (!prompt.data || prompt.data.kind === 'NONE') return null;
  if (prompt.data.kind === 'IDLE') return <IdlePrompt prompt={prompt.data} />;
  if (prompt.data.kind === 'AWAY') return <AwayPrompt prompt={prompt.data} />;
  return <PermissionPrompt prompt={prompt.data} />;
}
