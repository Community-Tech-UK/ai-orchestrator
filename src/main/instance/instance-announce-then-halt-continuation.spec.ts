import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import { detectTrailingAnnounceThenHalt } from '../orchestration/announce-then-halt-detector';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import {
  ANNOUNCE_THEN_HALT_CONTINUATION_PROMPT_PREFIX,
  InstanceAnnounceThenHaltContinuation,
  type InstanceAnnounceThenHaltContinuationHost,
} from './instance-announce-then-halt-continuation';

describe('detectTrailingAnnounceThenHalt', () => {
  it('rejects explanatory prose and textual provider-limit waits', () => {
    expect(detectTrailingAnnounceThenHalt("I'll explain how to run the full suite.")).toBeNull();
    expect(detectTrailingAnnounceThenHalt("I'll tell you why you should run the tests.")).toBeNull();
    expect(detectTrailingAnnounceThenHalt("I'll rerun this after the rate limit resets.")).toBeNull();
    expect(detectTrailingAnnounceThenHalt("I'll rerun this after the usage window resets.")).toBeNull();
    expect(detectTrailingAnnounceThenHalt("I'll rerun this after my five-hour allowance refreshes.")).toBeNull();
    const activeLimits = [
      "The rate limit is active. I'll run the suite later.",
      "I'm rate-limited. I'll run the suite when able.",
      "My usage window is exhausted. I'll run the suite later.",
      "My allowance is exhausted. I'll run the suite later.",
      "I'll run the suite once the quota clears.",
      "I'll run the suite after the provider limit lifts.",
      'My five-hour limit resets at 8. I will now run the suite.',
      'Provider capacity is exhausted. I will now run the suite.',
      'My credits are exhausted. I will now run the suite.',
    ];
    for (const output of activeLimits) {
      expect(detectTrailingAnnounceThenHalt(output), output).toBeNull();
    }
  });

  it('rejects quoted, fenced, blockquoted, and example/template promises', () => {
    expect(detectTrailingAnnounceThenHalt(
      'The wording to avoid is: “I’ll now run the full suite.”',
    )).toBeNull();
    expect(detectTrailingAnnounceThenHalt(
      'For example, you could say: I will now run the tests.',
    )).toBeNull();
    expect(detectTrailingAnnounceThenHalt(
      'Status template:\n```text\nI’ll now run the full suite.\n```',
    )).toBeNull();
    expect(detectTrailingAnnounceThenHalt(
      '> I’ll now run the full suite.',
    )).toBeNull();
    expect(detectTrailingAnnounceThenHalt(
      'He wrote, "I’ll now run the tests.',
    )).toBeNull();
    expect(detectTrailingAnnounceThenHalt(
      `Template:\n${'placeholder '.repeat(25)}I’ll now run the tests.`,
    )).toBeNull();
    expect(detectTrailingAnnounceThenHalt(
      `Template: ${'placeholder '.repeat(80)}I’ll now run the tests.`,
    )).toBeNull();
    expect(detectTrailingAnnounceThenHalt(
      'That old template is fixed. I’ll now run the tests.',
    )?.excerpt).toBe('I’ll now run the tests.');
  });

  it('rejects unquoted reported, template-introduction, and hypothetical prose', () => {
    const reportedOrHypothetical = [
      'The revised prompt should say: I will now run the tests.',
      'The model says I will now run the tests.',
      'Avoid the sentence I will now run the tests.',
      'If I will now run the tests, the output should appear here.',
      'Suppose I will now run the tests.',
      'A response might say: I will now run the tests.',
      'Never write I will now run the tests.',
      'Hypothetically, I will now run the tests.',
      'The model says that I will now run the tests.',
      'Here is the sentence: I will now run the tests.',
      'Avoid saying I will now run the tests.',
      'Whether I will now run the tests depends on the example.',
      'The assistant replied I will now run the tests.',
      'According to the transcript, I will now run the tests.',
      'What if I will now run the tests?',
      'Transcript: I will now run the tests.',
      'The assistant replied, I will now run the tests.',
      'Per the transcript, I will now run the tests.',
      "The assistant's response: I will now run the tests.",
      'The transcript records that I will now run the tests.',
      'I told the user I will now run the tests.',
      'I wonder if I will now run the tests.',
      'In theory, I will now run the tests.',
      'Assume I will now run the tests.',
      'The transcript shows I will now run the tests.',
      'I will now run the tests?',
      'His exact words were I will now run the tests.',
      'The required status line is I will now run the tests.',
      'Do you think I will now run the tests.',
      'In the event that I will now run the tests, record the outcome.',
      'I will now run the tests, right.',
      'Apparently I will now run the tests.',
      'It seems that I will now run the tests.',
      'A possible reply is I will now run the tests.',
      'This means I will now run the tests.',
      'It follows that I will now run the tests.',
      'The agent promised I will now run the integration suite.',
      'From that result, I infer I will now run the tests.',
      'Unless I will now run the tests, the branch should remain unchanged.',
      'I will now run the tests, should I not.',
      'The transcript reads as follows. I will now run the tests.',
      'A possible reply follows. I will now run the tests.',
      'Use this template. I will now run the tests.',
      'Imagine this scenario. I will now run the tests.',
      'Here is an example. I will now run the tests.',
      'The agent said the following. I will now run the tests.',
      'To illustrate. I will now run the tests.',
      'A template follows. Use it verbatim. I’ll now run the tests.',
      'A sample status follows. I will now run the checks.',
      'The report says. I will now run the checks.',
      'The documentation says. I will now run the checks.',
      'This is an example. I will now run the checks.',
      'For instance. I will now run the checks.',
      'Here is a sample. I will now run the checks.',
      'The following is an example. I will now run the checks.',
      'The guide states. I will now run the checks.',
      'The documentation reports. I will now run the checks.',
      'In this example. I will now run the tests.',
      'A worked example appears below. Step one is setup. Step two is review. I will now run the tests.',
      "Sample output:\nI'll now execute the smoke tests.",
      'A draft for the runbook:\nI’ll now inspect the deployment logs.',
      'Possible status update:\nI’m going to rerun the integration suite.',
      'Copyable reply:\nI’ll proceed to check the generated files.',
      "The following is a sample response. It is concise. It uses active voice. Keep its tense consistent. I'll now run the checks.",
      "In the tutorial, use the following closing line. Keep it on its own line. Preserve first person. Do not add caveats. I'll now test the endpoint.",
      "Copied text from another assistant:\nI'll now verify the schema.",
      'The archived reply ended with this closing line:\nI’ll now check the migration.',
      "Transcribed from the agent's final output:\nI'll now execute the unit tests.",
      'The following quotation was copied from a prior chat:\nI’m going to run the full suite.',
      'Someone paraphrased the closing sentence as follows:\nI am going to run the full suite.',
      'Example block:\n\n    I’ll now execute the smoke test.',
      "~~~text\nI'll now run the formatter.\n~~~",
      'Unclosed example:\n~~~\nI’ll now inspect the snapshot.',
      "<blockquote>\nI'll now review the logs.\n</blockquote>",
      '<pre>\nI will now inspect the generated file.\n</pre>',
      "The documentation's sample block starts here. Line one sets context. Line two explains timing. Line three closes the example. I'll now build the package.",
      'A teammate attributed this sentence to the model. I will now review the patch.',
      "The log captures the agent's final line. I'll now execute the unit tests.",
      'The following came from a prior chat. It had a terse style. It used future tense. It omitted detail. I’ll now run lint.',
      "An archived answer ended this way. Background came first. Results came second. A promise came last. I'll now inspect the bundle.",
      "The reviewer recalled the assistant's wording. I’ll now check the migration.",
      "Example\nI’ll now run the tests.",
      "Template\nI’ll now run the tests.",
      "A teammate wrote the update below. It is concise. I’ll now run the tests.",
      "This was the assistant’s closing promise. I’ll now run the tests.",
      "Do not output the following. I’ll now run the tests.",
      'This prompt is an example. I’ll now run the focused tests.',
      'The tool output says: I’ll now run the full suite.',
      'The documentation includes this line. I’ll now verify the implementation.',
      'Status report template follows. I’ll now inspect the generated package.',
      'If the error message is corrected, I’ll now rerun lint.',
      'Once you update the test fixture, I’ll now execute the regression suite.',
      'The response schema example ends here. I’ll now build the main process.',
      'Please avoid this commitment. I will now run the full suite.',
      'Do not repeat this promise. I will now run the full suite.',
      'These are not my words. I will now inspect the bundle.',
      'Ignore the next line. I will now run the checks.',
      'The example closes here; I will now run the tests.',
      'Maybe. I will now run the tests.',
      "Illustration:\nI’ll now run the accessibility checks.",
      'Demonstration:\nI will now inspect the generated manifest.',
      "Suggested copy:\nI'll now verify the deployment artifact.",
      'Training snippet:\nI’ll now test the cancellation branch.',
      "Synthetic close:\nI'll now build the desktop package.",
      'This is illustrative material. The opening gives context. The middle establishes tone. The final clause demonstrates intent. I’ll now check the checksum.',
      'The training exercise ends with this stanza. Preparation is complete. Timing is emphasized. Action is promised. I will now inspect the bundle.',
      'The prose specimen has five sentences. One establishes scope. Two establishes voice. Three establishes tense. I’ll now execute the formatter.',
      "The demonstration continues. Context comes first. Confidence comes second. Future tense comes last. I'm going to verify the endpoint.",
      "Words borrowed from an earlier bot:\nI’ll now run the compatibility check.",
      'The quoted material from yesterday:\nI will now inspect the release archive.',
      "An LLM generated this closing statement:\nI'll now test the recovery flow.",
      'Copied verbatim from the old run:\nI’m going to review the package contents.',
      'What the tool printed:\nI will now execute the final command.',
      'The imported prose starts with context. It then names the target. It then switches tense. Its closing statement is next. I’ll now run the tests.',
      'Verbatim material from the workshop follows. It uses one speaker. It is intentionally decisive. It concludes like this. I will now inspect the file.',
      "literal: |\n  I'll now test the retry path.",
    ];
    for (const output of reportedOrHypothetical) {
      expect(detectTrailingAnnounceThenHalt(output), output).toBeNull();
    }
    expect(detectTrailingAnnounceThenHalt(
      'The model is ready. I will now run the tests.',
    )?.excerpt).toBe('I will now run the tests.');
    expect(detectTrailingAnnounceThenHalt(
      "I'll now run the failing tests.",
    )?.excerpt).toBe("I'll now run the failing tests.");
    expect(detectTrailingAnnounceThenHalt(
      "I'll now fix the failed test.",
    )?.excerpt).toBe("I'll now fix the failed test.");
    expect(detectTrailingAnnounceThenHalt(
      "Even though the tests failed, I'll now fix the failing test.",
    )?.excerpt).toBe("I'll now fix the failing test.");
    expect(detectTrailingAnnounceThenHalt(
      "For completeness, I'll now run the tests.",
    )?.excerpt).toBe("I'll now run the tests.");
    expect(detectTrailingAnnounceThenHalt(
      "Before I finish, I'll now run the tests.",
    )?.excerpt).toBe("I'll now run the tests.");
    expect(detectTrailingAnnounceThenHalt(
      'Okay — I will now run the tests.',
    )?.excerpt).toBe('I will now run the tests.');
    expect(detectTrailingAnnounceThenHalt(
      'With that settled, I will now run the tests.',
    )?.excerpt).toBe('I will now run the tests.');
    expect(detectTrailingAnnounceThenHalt(
      "Having done that, I'll now run the tests.",
    )?.excerpt).toBe("I'll now run the tests.");
    expect(detectTrailingAnnounceThenHalt(
      "One final step: I'll now run the tests.",
    )?.excerpt).toBe("I'll now run the tests.");
    const directCommitments = [
      'Okay, I’m going to update the fixture.',
      'After reviewing the diff, I’ll now run lint.',
      '- I’ll now run the tests.',
      'Next step: I’ll now run the tests.',
      'The fix is in\nI’ll now run the tests.',
      'I’ll now review the final diff.',
      'I’ll now apply the correction.',
      'I’ll proceed to run the suite.',
      "After that, I'll run the final suite.",
      "Now that the fix is approved, I'll run the final suite.",
      'Now that the patch has landed, I’ll run the final suite.',
      "After correcting the fixture, I'll rerun the focused test.",
      'Now that provider capacity is restored, I’ll run the final suite.',
      "The rate limit has cleared. I'll now execute the remaining checks.",
      '**Next:** I’ll now inspect the packaged assets.',
      "- [ ] I'll now run the regression test.",
      'Next action — I’ll now review the fixture.',
      "Here’s what I’ll do next: I’ll now run the integration test.",
      "I'll now rerun the suite. The previous attempt failed.",
      'I’ll now inspect another file. The first file is already checked.',
      "I'll now execute the focused checks. This should take under a minute.",
      'I will inspect the remaining module. The step is read-only.',
      "I'm going to update the fixture. No user input is required.",
      'I need to verify the checksum. I expect a quick answer.',
      "Next, I'll run the packaging check. It may take a moment.",
      '* [ ] I will now check the generated types.',
      'I will run the suite. This should take about five minutes.',
      'I will inspect the patch. It should only take a moment.',
      'I will check the configuration. This is a read-only check.',
      'I updated the prompt. I’ll now run the focused tests.',
      'The tool output is clean. I’ll now run the full suite.',
      'I reviewed the documentation. I’ll now verify the implementation.',
      'The status report is complete. I’ll now inspect the generated package.',
      'The error message is corrected. I’ll now rerun lint.',
      'I checked the response schema. I’ll now build the main process.',
      "After reviewing the diff, I'll run the tests.",
      "Now that capacity is restored, I'll run the tests.",
      "After checking the schema, I'll build the main process.",
      "Because lint failed, I'll fix the config.",
      'The patch is in, and I’ll now run the tests.',
      'The implementation is complete and I will now run the full suite.',
      "I checked James' patch. I’ll now run the tests.",
      "I reviewed the agents' output. I’ll now verify the build.",
    ];
    for (const output of directCommitments) {
      expect(detectTrailingAnnounceThenHalt(output), output).not.toBeNull();
    }
  });

  it('rejects broader approval and user-dependency language', () => {
    const dependencies = [
      "I'll run the deployment as soon as you approve.",
      "I'll run the deployment provided you approve.",
      "I'll run the deployment subject to your approval.",
      "I'll run the deployment on your go-ahead.",
      "I'll now run the deployment. Waiting for your approval.",
      "I'll now run the deployment. I cannot proceed without your approval.",
    ];
    for (const output of dependencies) {
      expect(detectTrailingAnnounceThenHalt(output), output).toBeNull();
    }
  });

  it('rejects promises explicitly deferred to a later time', () => {
    const deferredPromises = [
      "I'll run the tests later.",
      "I'll run the tests tomorrow.",
      "I'll run the tests eventually.",
      "I'll run the tests when able.",
      "I'll run the suite on Tuesday.",
      "I'll run the suite after lunch.",
      "I'll run the suite at 5pm.",
      "I'll run the suite when the build server returns.",
      'I will now run the tests if the server is available.',
      "I'll now run the suite whenever the runner comes back.",
      'I’ll now execute the tests as soon as CI recovers.',
      'I will now inspect the artifacts pending the upload finishing.',
      "I'll now review the logs in the morning.",
      'I’ll now run the benchmark next quarter.',
      'I will now build the installer at noon.',
      'I’ll now verify the deployment upon service restoration.',
      "I'll run the tests someday.",
      "I'll run the tests in due course.",
      "I'll run the tests as time permits.",
      "I'll run the tests at some point.",
      "I'll now run the suite this afternoon.",
      'I will now inspect the archive tonight.',
      'I’m going to verify the release over the weekend.',
      'I’ll now test the migration next year.',
      'I will now execute the benchmark at dawn.',
      "I'll now review the change at close of business.",
      'I’m going to build the installer during the maintenance window.',
      'I will now check the service following the restart.',
      'I’ll now inspect the logs before long.',
      "I'm going to run the job in a while.",
      'I will now test the endpoint in two hours.',
      "I'll now verify the rollout on 12 September.",
      'I’m going to review the API in the next release.',
      'I will now run the checks at 14:00.',
      "I'll now execute the migration this weekend.",
      'I will run the checks in 30 seconds.',
      'I will run the checks in half an hour.',
      'I will run the checks this Friday.',
      'I will run the checks next Tuesday.',
      'I will run the checks at three o’clock.',
      "After reviewing the diff, I'll run the tests tomorrow.",
      "After that, I'll run the tests next week.",
      "Now that the fix is approved, I'll run the tests in two hours.",
      "For completeness, I'll run the tests later.",
      "Before I finish, I'll run the tests tomorrow.",
      "Now that capacity is restored, I'll run the tests when CI recovers.",
      "After checking the schema, I'll build the main process tonight.",
      "Because lint failed, I'll fix the config next Tuesday.",
    ];
    for (const output of deferredPromises) {
      expect(detectTrailingAnnounceThenHalt(output), output).toBeNull();
    }
  });

  it('rejects blockers and completion evidence after the promised action', () => {
    const blockedOrCompleted = [
      "I'll now run the full suite. I need your approval first.",
      "I'll now run the full suite. My credits are exhausted.",
      "I'll now run the full suite. That will happen later.",
      "I'll now run the full suite. Provider capacity is exhausted.",
      "I'll now run the full suite. I am rate-limited.",
      "I'll now run the full suite. All 21,323 tests passed.",
      "I'll now inspect the file. I inspected it and found no issue.",
      "I'll now inspect. The inspection is complete.",
      "I'll now run the suite. The results show 21 tests passing.",
      "I'll now run the suite; all 21 tests are passing.",
      "I'll now run the suite, which passed all 21 tests.",
      "I'll now run the suite. All tests are green.",
      "I'll now run the suite. There were zero failures.",
      "I'll now run the suite and it passed all tests.",
      "I'll now run the suite and all tests passed.",
      "I'll now run the suite but it failed immediately.",
      "I'll now run the suite and passed all tests.",
      "I'll now inspect the logs and found the cause.",
      "I'll now run the suite — all 42 tests passed.",
      "I'll now run the suite - all 42 tests passed.",
      "I'll now run the suite, all 42 tests passed.",
      "I'll now run the suite (all 42 tests passed).",
      "I'll now run the suite although it passed.",
      "I'll now run the suite (which passed earlier).",
      "I'll now run the tests (42 tests passed).",
      "I'll now run the suite—42 tests passed.",
      "I'll now inspect the logs (done: no issues).",
      "I'll now run the suite, passing all 42 tests.",
      "I'll now run the suite. The build server is offline.",
      'I’ll now execute the integration tests. Docker is unavailable.',
      'I will now build the package. The required SDK is not installed.',
      "I'll now inspect the remote logs. The host cannot be reached.",
      'I’ll now test the endpoint. The network is disconnected.',
      'I will now update the file. The workspace is read-only.',
      'I’ll now run the migration. The database is offline.',
      "I'll now execute the command. The binary is missing.",
      "I'll now run the suite. Exit code was 0.",
      'I’ll now execute the command. It returned zero.',
      'I will now inspect the logs. Root cause: a timeout.',
      "I'll now apply the patch. The diff is now present.",
      'I’ll now check the configuration. No changes were needed.',
      'I will now test the endpoint. HTTP 200 was returned.',
      "I'll now build the target. The artifact exists at dist/app.js.",
      'I’ll now review the output. Nothing unexpected appeared.',
      'I’ll now test the change, or perhaps not.',
      "I'll now inspect the bundle — the artifact exists.",
      "I'll now test the endpoint — HTTP 200 confirmed the response.",
      "I'll now inspect the file — the issue was found.",
      'I will execute the command, exit status 0.',
      'I will inspect the endpoint, got HTTP 204.',
      'I will build the app (artifact generated).',
      'I will run the suite, I guess.',
      'I will run the suite, probably.',
      'I will run the suite, hopefully.',
      "I'll now run the suite, but CI is offline.",
      "I'll now run the suite because it already passed.",
      'I will now run the tests or wait for CI.',
    ];
    for (const output of blockedOrCompleted) {
      expect(detectTrailingAnnounceThenHalt(output), output).toBeNull();
    }
  });

  it('selects the last valid trailing promise instead of an earlier action phrase', () => {
    const output = [
      "I'll explain how to run the checks.",
      `${'Context '.repeat(25)}.`,
      "I'll now run the full suite.",
    ].join(' ');

    expect(detectTrailingAnnounceThenHalt(output)?.excerpt)
      .toBe("I'll now run the full suite.");
  });
});

function completionEnvelope(
  instanceId = 'instance-1',
  degradedReason?: 'delayed',
  content = "Terminate and Stop were confirmed clean. I'll run the full suite and send Wave 3 back for a second gate pass.",
  requestCountAtProviderCompletion = 3,
): ProviderRuntimeEventEnvelope {
  return {
    eventId: 'event-1',
    seq: 1,
    timestamp: 1,
    provider: 'claude',
    instanceId,
    raw: {
      source: 'adapter-event:complete',
      payload: {
        content,
      },
    },
    event: {
      kind: 'complete',
      requestCountAtCompletion: requestCountAtProviderCompletion,
      ...(degradedReason ? { degradedReason } : {}),
    },
  };
}

function assistant(
  content: string,
  id = 'assistant-1',
): Instance['outputBuffer'][number] {
  return {
    id,
    type: 'assistant',
    content,
    timestamp: 1,
  };
}

describe('InstanceAnnounceThenHaltContinuation', () => {
  let events: EventEmitter;
  let registry: InstanceAsyncWorkRegistry;
  let instance: Instance;
  let host: InstanceAnnounceThenHaltContinuationHost;
  let sendInput: ReturnType<typeof vi.fn>;
  let isManagedLoopInstance: ReturnType<typeof vi.fn>;
  let isPaused: ReturnType<typeof vi.fn>;
  let continuation: InstanceAnnounceThenHaltContinuation;

  beforeEach(() => {
    events = new EventEmitter();
    registry = new InstanceAsyncWorkRegistry();
    instance = {
      id: 'instance-1',
      parentId: null,
      launchMode: 'orchestrated',
      status: 'idle',
      requestCount: 3,
      outputBuffer: [assistant(
        "Terminate and Stop were confirmed clean. I'll run the full suite and send Wave 3 back for a second gate pass.",
      )],
    } as Instance;
    sendInput = vi.fn(async (_instanceId, _message, _attachments, options) => {
      (options as { beforeProviderDispatch?: () => void } | undefined)
        ?.beforeProviderDispatch?.();
      instance.requestCount += 1;
    });
    isManagedLoopInstance = vi.fn(() => false);
    isPaused = vi.fn(() => false);
    host = {
      on: (event, listener) => events.on(event, listener),
      off: (event, listener) => events.off(event, listener),
      getInstance: vi.fn(() => instance),
      waitForInstanceSettled: vi.fn(async () => instance),
      sendInput,
    };
    continuation = new InstanceAnnounceThenHaltContinuation(
      registry,
      host,
      isManagedLoopInstance,
      isPaused,
    );
    continuation.start();
  });

  afterEach(() => continuation.stop());

  it('continues the reproduced root-session promise after the turn settles', async () => {
    events.emit('provider:normalized-event', completionEnvelope());

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(host.waitForInstanceSettled).toHaveBeenCalledOnce();
    expect(sendInput).toHaveBeenCalledWith(
      'instance-1',
      expect.stringContaining(ANNOUNCE_THEN_HALT_CONTINUATION_PROMPT_PREFIX),
      undefined,
      {
        autoContinuation: true,
        signal: expect.any(AbortSignal),
        beforeProviderDispatch: expect.any(Function),
      },
    );
    expect(sendInput.mock.calls[0][1]).toContain('run the full suite');
  });

  it('uses the latest assistant output when the normalized completion has no content', async () => {
    const envelope: ProviderRuntimeEventEnvelope = {
      ...completionEnvelope(),
      raw: {
        source: 'adapter-event:complete',
        payload: { id: 'complete-without-content' },
      },
    };

    events.emit('provider:normalized-event', envelope);

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput.mock.calls[0][1]).toContain('run the full suite');
  });

  it('prefers authoritative completion content over an older buffered assistant', async () => {
    instance.outputBuffer = [assistant('The previous turn is complete.')];

    events.emit('provider:normalized-event', completionEnvelope());

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput.mock.calls[0][1]).toContain('run the full suite');
  });

  it('does not fall back past a newer user message to an older assistant', async () => {
    instance.outputBuffer = [
      assistant("I'll now run the old checks."),
      {
        id: 'user-2',
        type: 'user',
        content: 'Do something different.',
        timestamp: 2,
      },
    ];
    const envelope: ProviderRuntimeEventEnvelope = {
      ...completionEnvelope(),
      raw: {
        source: 'adapter-event:complete',
        payload: { id: 'complete-without-content' },
      },
    };

    events.emit('provider:normalized-event', envelope);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('rejects an older completion that arrives after newer manual input starts', async () => {
    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: false,
    });
    instance.requestCount += 1;

    events.emit('provider:normalized-event', completionEnvelope());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('rejects an old raw completion even after the newer assistant starts', async () => {
    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: false,
    });
    instance.requestCount += 1;
    instance.outputBuffer = [assistant("I'll now run the NEW turn checks.", 'assistant-2')];

    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "I'll now run the OLD turn checks.",
    ));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('fails closed when a completion has no authoritative request-count fence', async () => {
    const envelope: ProviderRuntimeEventEnvelope = {
      ...completionEnvelope(),
      raw: {
        source: 'adapter-event:complete',
        payload: { content: "I'll now run the tests." },
      },
      event: { kind: 'complete' },
    };

    events.emit('provider:normalized-event', envelope);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('rejects a crash-redacted old completion after a newer assistant starts', async () => {
    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: false,
    });
    instance.requestCount += 1;
    instance.outputBuffer = [assistant("I'll now run the NEW turn checks.", 'assistant-2')];
    const envelope = {
      ...completionEnvelope(),
      raw: undefined,
      event: {
        kind: 'complete',
        requestCountAtCompletion: 3,
      },
    } as unknown as ProviderRuntimeEventEnvelope;

    events.emit('provider:normalized-event', envelope);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('suppresses a queued continuation when a newer turn starts before settlement', async () => {
    instance.status = 'busy';
    let settle!: () => void;
    host.waitForInstanceSettled = vi.fn(() => new Promise<void>((resolve) => {
      settle = resolve;
    }));

    events.emit('provider:normalized-event', completionEnvelope());
    await vi.waitFor(() => expect(host.waitForInstanceSettled).toHaveBeenCalledOnce());
    instance.requestCount += 1;
    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: false,
    });
    instance.status = 'idle';
    settle();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('lets a newer completed user turn supersede an older queued continuation', async () => {
    instance.status = 'busy';
    let settleOlder!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settleOlder = resolve;
    });
    host.waitForInstanceSettled = vi.fn(() => settlement);

    events.emit('provider:normalized-event', completionEnvelope());
    await vi.waitFor(() => expect(host.waitForInstanceSettled).toHaveBeenCalledOnce());

    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: false,
    });
    instance.requestCount += 1;
    instance.status = 'idle';
    instance.outputBuffer = [assistant("I'll now run the newer turn's checks.", 'assistant-2')];
    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "I'll now run the newer turn's checks.",
      4,
    ));
    settleOlder();

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput.mock.calls[0][1]).toContain("newer turn's checks");
  });

  it('does not compete with provider-native background work', async () => {
    registry.observe('instance-1', {
      phase: 'started',
      workId: 'background-1',
      kind: 'background-shell',
    });

    events.emit('provider:normalized-event', completionEnvelope());
    await Promise.resolve();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it('does not schedule for a root instance owned by an active managed loop', async () => {
    isManagedLoopInstance.mockReturnValue(true);

    events.emit('provider:normalized-event', completionEnvelope());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('suppresses delivery when a managed loop takes ownership while settling', async () => {
    instance.status = 'busy';
    let settle!: () => void;
    host.waitForInstanceSettled = vi.fn(() => new Promise<void>((resolve) => {
      settle = resolve;
    }));

    events.emit('provider:normalized-event', completionEnvelope());
    await vi.waitFor(() => expect(host.waitForInstanceSettled).toHaveBeenCalledOnce());
    isManagedLoopInstance.mockReturnValue(true);
    instance.status = 'idle';
    settle();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('does not queue while a session is waiting for permission or user input', async () => {
    for (const status of ['waiting_for_permission', 'waiting_for_input'] as const) {
      instance.status = status;
      events.emit('provider:normalized-event', completionEnvelope());
    }
    await Promise.resolve();

    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('ignores child, interactive, degraded, and user-dependent completions', async () => {
    instance.parentId = 'parent-1';
    events.emit('provider:normalized-event', completionEnvelope());

    instance.parentId = null;
    instance.launchMode = 'interactive';
    events.emit('provider:normalized-event', completionEnvelope());

    instance.launchMode = 'orchestrated';
    events.emit('provider:normalized-event', completionEnvelope('instance-1', 'delayed'));

    instance.outputBuffer = [assistant("Once you approve, I'll run the deployment.")];
    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "Once you approve, I'll run the deployment.",
    ));

    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "I'll run the deployment once I receive your approval.",
    ));

    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "I'll run the deployment after receiving your approval.",
    ));

    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "Once you give me the command. I'll run the deployment.",
    ));
    await Promise.resolve();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it('cancels an already-waiting delivery when the coordinator stops', async () => {
    instance.status = 'busy';
    let settle!: () => void;
    host.waitForInstanceSettled = vi.fn(() => new Promise<void>((resolve) => {
      settle = resolve;
    }));

    events.emit('provider:normalized-event', completionEnvelope());
    await vi.waitFor(() => expect(host.waitForInstanceSettled).toHaveBeenCalledOnce());
    continuation.stop();
    instance.status = 'idle';
    settle();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('carries cancellation through an already-started send preflight', async () => {
    let enterPreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      enterPreflight = resolve;
    });
    let releasePreflight!: () => void;
    const preflightReleased = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let adapterDispatched = false;
    host.sendInput = vi.fn(async (_instanceId, _message, _attachments, options) => {
      enterPreflight();
      await preflightReleased;
      if (options?.signal?.aborted !== true) adapterDispatched = true;
    });

    events.emit('provider:normalized-event', completionEnvelope());
    await preflightEntered;
    continuation.stop();
    releasePreflight();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(adapterDispatched).toBe(false);
  });

  it('cancels an automatic send preflight as soon as newer manual input starts', async () => {
    let enterPreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      enterPreflight = resolve;
    });
    let releasePreflight!: () => void;
    const preflightReleased = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let adapterDispatched = false;
    host.sendInput = vi.fn(async (_instanceId, _message, _attachments, options) => {
      enterPreflight();
      await preflightReleased;
      if (options?.signal?.aborted !== true) adapterDispatched = true;
    });

    events.emit('provider:normalized-event', completionEnvelope());
    await preflightEntered;
    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: false,
    });
    releasePreflight();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(adapterDispatched).toBe(false);
  });

  it.each([
    'pause',
    'managed Loop ownership',
    'provider-native background work',
  ])('suppresses provider dispatch when %s begins during the send preflight', async (condition) => {
    let enterPreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      enterPreflight = resolve;
    });
    let releasePreflight!: () => void;
    const preflightReleased = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let adapterDispatched = false;
    host.sendInput = vi.fn(async (_instanceId, _message, _attachments, options) => {
      enterPreflight();
      await preflightReleased;
      (options as { beforeProviderDispatch?: () => void } | undefined)
        ?.beforeProviderDispatch?.();
      adapterDispatched = true;
    });

    events.emit('provider:normalized-event', completionEnvelope());
    await preflightEntered;
    if (condition === 'pause') {
      isPaused.mockReturnValue(true);
    } else if (condition === 'managed Loop ownership') {
      isManagedLoopInstance.mockReturnValue(true);
    } else {
      registry.observe('instance-1', {
        phase: 'started',
        workId: 'background-during-preflight',
        kind: 'background-shell',
      });
    }
    releasePreflight();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(adapterDispatched).toBe(false);
  });

  it('allows only one automatic nudge until a later manual turn changes the request chain', async () => {
    events.emit('provider:normalized-event', completionEnvelope());
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));

    instance.outputBuffer = [assistant("I'll now run the remaining tests.")];
    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "I'll now run the remaining tests.",
      4,
    ));
    await Promise.resolve();
    expect(sendInput).toHaveBeenCalledTimes(1);

    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: false,
    });
    instance.requestCount += 1;
    instance.outputBuffer = [assistant("I'll now run the remaining tests.", 'assistant-2')];
    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "I'll now run the remaining tests.",
      5,
    ));
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2));
  });

  it('does not reset the nudge cap for another automatic continuation', async () => {
    events.emit('provider:normalized-event', completionEnvelope());
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));

    events.emit('instance:input-started', {
      instanceId: 'instance-1',
      autoContinuation: true,
    });
    instance.requestCount += 1;
    events.emit('provider:normalized-event', completionEnvelope(
      'instance-1',
      undefined,
      "I'll now run the remaining tests.",
      5,
    ));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendInput).toHaveBeenCalledTimes(1);
  });
});
