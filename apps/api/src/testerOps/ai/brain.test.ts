import { afterEach, describe, expect, it } from 'vitest';
import { getTesterOpsAiClient, setTesterOpsAiClientForTests, type TesterOpsAiClient } from './brain';
import { redactJson, redactText } from '../redact';

afterEach(() => {
  setTesterOpsAiClientForTests(null);
});

describe('tester ops AI brain seam', () => {
  it('can route messages through a fake client without live model calls', async () => {
    const fake: TesterOpsAiClient = {
      async decideMessage(input) {
        return {
          aiRunId: 'fake-run',
          decision: {
            intent: input.directMention ? 'DOC_QUESTION' : 'ISSUE_REPORT',
            confidence: 0.91,
            language: 'hinglish',
            category: 'upload',
            severity: 'HIGH',
            summary: 'Screenshot upload is failing for a tester.',
            safeAction: input.directMention ? 'ANSWER_FROM_DOCS' : 'LOG_ISSUE',
            replyText: 'Logged. I am keeping this in Tester Ops.',
            needsClarification: false,
            clarifyingQuestion: null,
            citations: [],
          },
        };
      },
      async answerDocs() {
        return {
          aiRunId: 'fake-doc-run',
          answer: {
            confidence: 0.8,
            answer: 'Test the screenshot upload flow first.',
            missingInfo: null,
            refusalReason: null,
            citations: [{ title: 'Grind QA Plan', url: 'https://example.test/doc' }],
          },
        };
      },
    };
    setTesterOpsAiClientForTests(fake);

    const ai = getTesterOpsAiClient();
    const issue = await ai.decideMessage({
      workspaceId: 'ws',
      messageText: 'screenshots are not uploading',
      directMention: false,
    });
    const docs = await ai.answerDocs({ workspaceId: 'ws', question: 'what should I test?', chunks: [] });

    expect(issue.decision.safeAction).toBe('LOG_ISSUE');
    expect(issue.decision.confidence).toBeGreaterThan(0.9);
    expect(docs.answer.answer).toContain('screenshot upload');
  });

  it('redacts token-like values before audit/log surfaces', () => {
    expect(redactText('Bearer abc.def.ghi')).toContain('[redacted]');
    expect(redactJson({ appSecret: 'secret-value', body: 'node12345678901234567890' })).toEqual({
      appSecret: '[redacted]',
      body: '[redacted]',
    });
  });
});

