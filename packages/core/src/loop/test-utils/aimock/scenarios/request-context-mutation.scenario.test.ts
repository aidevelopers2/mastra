/**
 * AIMock Scenario: RequestContext Mutation Behavior
 *
 * Documents requestContext mutation visibility between tool executions. Direct
 * engines share the original requestContext instance across the run. The evented
 * engine reconstructs requestContext from serialized workflow state between
 * steps, so tool-local mutations do not update the original instance.
 *
 * This is important behavior to document because it means:
 * - Direct engines can use requestContext to share state between tools
 * - Evented execution keeps tool mutations local to each workflow step
 * - The original requestContext mutation behavior is engine-specific
 *
 * Asserts:
 * - Direct-engine tool mutations persist to subsequent tool calls
 * - Evented-engine tool mutations do not persist to subsequent tool calls
 * - The original requestContext object follows the engine-specific behavior
 */

import { stepCountIs } from '@internal/ai-sdk-v5';
import { it, expect } from 'vitest';
import { z } from 'zod/v4';
import { createTool } from '../../../../tools';
import { RequestContext } from '../../../../request-context';
import { runLoopScenario, useLoopScenarioAimock, describeForAllEngines } from '../aimock-scenario';

describeForAllEngines('AIMock loop scenario: requestContext mutation behavior', engine => {
  const getMock = useLoopScenarioAimock();

  it('documents tool mutation visibility for subsequent tool calls', async () => {
    const step1Values: string[] = [];
    const step2Values: string[] = [];

    const mutateTool = createTool({
      id: 'mutate',
      description: 'Attempts to mutate the requestContext',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ success: z.boolean() }),
      execute: async (input, context) => {
        // Read current value before mutation
        const before = (context?.requestContext?.get('counter') || 'none') as string;
        step1Values.push(before);

        // Mutate the shared context for later tool calls in this run.
        context?.requestContext?.set('counter', input.value);

        return { success: true };
      },
    });

    const readTool = createTool({
      id: 'read',
      description: 'Reads the requestContext value',
      inputSchema: z.object({}),
      outputSchema: z.object({ value: z.string() }),
      execute: async (_input, context) => {
        const value = (context?.requestContext?.get('counter') || 'none') as string;
        step2Values.push(value);
        return { value };
      },
    });

    const requestContext = new RequestContext();
    requestContext.set('counter', 'initial');

    const { output, requests } = await runLoopScenario({
      engine,
      llm: getMock(),
      prompt: 'First mutate, then read the value.',
      tools: { mutate: mutateTool, read: readTool },
      stopWhen: stepCountIs(3),
      requestContext,
      fixtures: llm => {
        // Turn 1: call mutate tool (no tool result yet)
        llm.on(
          { endpoint: 'chat', hasToolResult: false },
          {
            toolCalls: [{ id: 'call_mutate', name: 'mutate', arguments: { value: 'step1-value' } }],
          },
        );
        // Turn 2: call read tool (has tool result from mutate)
        llm.on(
          { endpoint: 'chat', toolCallId: 'call_mutate' },
          {
            toolCalls: [{ id: 'call_read', name: 'read', arguments: {} }],
          },
        );
        // Turn 3: summarize (has tool result from read)
        llm.on(
          { endpoint: 'chat', toolCallId: 'call_read' },
          { content: 'The counter changed because requestContext mutations persist.' },
        );
      },
    });

    // Step 1: mutate tool saw the initial value
    expect(step1Values).toEqual(['initial']);

    const mutationsPersist = engine !== 'evented';

    // Direct engines share the tool mutation; evented reconstructs context.
    expect(step2Values).toEqual([mutationsPersist ? 'step1-value' : 'initial']);

    // The original requestContext object follows the same engine behavior.
    expect(requestContext.get('counter')).toBe(mutationsPersist ? 'step1-value' : 'initial');

    // All three turns executed
    expect(requests).toHaveLength(3);
  });

  it('documents sequential requestContext mutation behavior', async () => {
    const mutations: string[] = [];

    const incrementTool = createTool({
      id: 'increment',
      description: 'Attempts to increment a counter in requestContext',
      inputSchema: z.object({}),
      outputSchema: z.object({ count: z.number() }),
      execute: async (_input, context) => {
        const current = Number(context?.requestContext?.get('count') || '0');
        const next = current + 1;
        context?.requestContext?.set('count', String(next));
        mutations.push(`saw:${current},set:${next}`);
        return { count: next };
      },
    });

    const requestContext = new RequestContext();
    requestContext.set('count', '0');

    const { output } = await runLoopScenario({
      engine,
      llm: getMock(),
      prompt: 'Increment the counter three times.',
      tools: { increment: incrementTool },
      stopWhen: stepCountIs(4),
      requestContext,
      fixtures: llm => {
        // Turn 1: first increment call (no tool result yet)
        llm.on(
          { endpoint: 'chat', hasToolResult: false },
          { toolCalls: [{ id: 'call_inc_1', name: 'increment', arguments: {} }] },
        );
        // Turn 2: second increment call (has tool result from call_inc_1)
        llm.on(
          { endpoint: 'chat', toolCallId: 'call_inc_1' },
          { toolCalls: [{ id: 'call_inc_2', name: 'increment', arguments: {} }] },
        );
        // Turn 3: third increment call (has tool result from call_inc_2)
        llm.on(
          { endpoint: 'chat', toolCallId: 'call_inc_2' },
          { toolCalls: [{ id: 'call_inc_3', name: 'increment', arguments: {} }] },
        );
        // Turn 4: summarize (has tool result from call_inc_3)
        llm.on(
          { endpoint: 'chat', toolCallId: 'call_inc_3' },
          { content: 'Each increment used the latest shared requestContext value.' },
        );
      },
    });

    const mutationsPersist = engine !== 'evented';

    // Direct engines accumulate mutations; evented reconstructs context for
    // each workflow step from the original serialized values.
    expect(mutations).toEqual(
      mutationsPersist ? ['saw:0,set:1', 'saw:1,set:2', 'saw:2,set:3'] : ['saw:0,set:1', 'saw:0,set:1', 'saw:0,set:1'],
    );

    // The original requestContext follows the same engine behavior.
    expect(requestContext.get('count')).toBe(mutationsPersist ? '3' : '0');
  });
});
