import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRuntime } from './runtime.ts';
import type { Runtime, RuntimeEvent } from './types.ts';
import { attachStatus, readDefaultStatus, safeText } from './status.ts';
import { registerProcessTool } from './tool.ts';
import { createUIState, ProcessesUI } from './ui.ts';

export function registerProcesses(pi: ExtensionAPI, factory: () => Runtime = createRuntime, agentDir: () => string = getAgentDir): void {
  let generation = 0, blocked = false;
  let owned: { runtime: Runtime; off: () => void; status: ReturnType<typeof attachStatus>; ctx: ExtensionContext } | undefined;
  let interaction: { close: () => void; token: object } | undefined;
  let state = createUIState();
  const delivered = new Set<string>();
  const disposals = new Set<Promise<void>>();
  const warn = (ctx: ExtensionContext, text: string) => {
    const clean = safeText(text);
    if (ctx.hasUI) { try { ctx.ui.notify(clean, 'error'); return; } catch { /* Fallback below. */ } }
    console.error(clean);
  };
  const ensure = (ctx: ExtensionContext) => {
    if (blocked) throw new Error('Process session is closing');
    if (owned) return owned;
    const runtime = factory(), started = generation;
    const status = attachStatus(pi, ctx, () => runtime.snapshot(), readDefaultStatus(agentDir(), text => warn(ctx, text)));
    const off = runtime.subscribe((event: RuntimeEvent) => {
      if (started !== generation || owned?.runtime !== runtime) return;
      if (event.type === 'snapshot') status.publish(event.snapshot);
      if (event.type !== 'notification' || delivered.has(event.key) || event.attention === 'ignore') return;
      delivered.add(event.key);
      if (delivered.size > 4096) delivered.delete(delivered.values().next().value!);
      const attention = event.attention;
      try {
        pi.sendMessage({ customType: 'process-notification', content: safeText(event.text, true), display: true,
          details: { id: safeText(event.id), kind: event.kind, attention } },
        attention === 'turn' ? { triggerTurn: true, deliverAs: 'steer' } : { triggerTurn: false, deliverAs: 'nextTurn' });
      } catch (error) { if (started === generation) warn(ctx, `Process notification failed: ${safeText(error instanceof Error ? error.message : error)}`); }
    });
    owned = { runtime, off, status, ctx };
    status.publish(runtime.snapshot());
    return owned;
  };
  const release = async (): Promise<void> => {
    const started = ++generation;
    blocked = true;
    const old = owned; owned = undefined;
    const oldInteraction = interaction; interaction = undefined;
    try { oldInteraction?.close(); } catch (error) { console.error(`Process UI cleanup failed: ${safeText(error)}`); }
    old?.off(); old?.status.dispose();
    state = createUIState(); delivered.clear();
    if (old) {
      const disposal = Promise.resolve().then(() => old.runtime.dispose()).catch(error => {
        const text = `Process cleanup failed: ${safeText(error instanceof Error ? error.message : error)}`;
        // Cleanup failures must remain visible, but not in a replacement session.
        if (started === generation) warn(old.ctx, text); else console.error(text);
      });
      disposals.add(disposal);
      void disposal.then(() => disposals.delete(disposal));
    }
    await Promise.all([...disposals]);
  };
  registerProcessTool(pi, ctx => {
    const { runtime } = ensure(ctx), started = generation;
    return { runtime, current: () => generation === started && owned?.runtime === runtime };
  });
  pi.registerCommand('processes', {
    description: 'Inspect session processes, logs, stop, acknowledge, and clear',
    handler: async (_args, ctx) => {
      const { runtime } = ensure(ctx), started = generation;
      if (ctx.mode !== 'tui') {
        const runs = runtime.snapshot().runs;
        const text = runs.length ? runs.map(r => `${safeText(r.id)} · ${safeText(r.name)} · ${safeText(r.outcome ?? r.phase)}${r.error ? ` · ${safeText(r.error)}` : ''}`).join('\n') : 'No processes';
        if (ctx.hasUI) ctx.ui.notify(text, 'info'); else console.error(text);
        return;
      }
      if (interaction) return;
      const token = {};
      interaction = { token, close: () => {} };
      try {
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
          if (started !== generation) { done(); return { render: () => [], invalidate() {} }; }
          let finished = false;
          const finish = () => { if (!finished) { finished = true; done(); } };
          const component = new ProcessesUI({ runtime, state, theme, keybindings,
            getHeight: () => Math.max(1, Math.min(24, tui.terminal.rows - 2)), getWidth: () => tui.terminal.columns,
            onChange: () => tui.requestRender(), onClose: finish,
            act: async (_id, operation) => {
              if (started !== generation) throw new Error('Process session changed');
              return await operation();
            },
          });
          if (interaction?.token === token) interaction.close = () => { component.dispose(); finish(); };
          return component;
        }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '95%', anchor: 'center', margin: { left: 1, right: 1 } } });
      } catch (error) { if (started === generation) warn(ctx, `Cannot open processes: ${safeText(error instanceof Error ? error.message : error)}`); }
      finally { if (interaction?.token === token) { interaction.close(); interaction = undefined; } }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    const pending = release(), started = generation;
    await pending;
    if (started !== generation) return;
    blocked = false; ensure(ctx);
  });
  pi.on('session_shutdown', async () => { await release(); });
}

export default function processes(pi: ExtensionAPI): void { registerProcesses(pi); }
