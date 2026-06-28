/**
 * list-models extension — registers a `list_models` tool that enumerates
 * all models the user has API keys (or OAuth) configured for.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_models",
    label: "List Models",
    description:
      "List available AI models the user has signed in for (API keys or OAuth configured). " +
      "Returns provider, model ID, display name, context window, max output tokens, " +
      "whether it supports reasoning/thinking, and supported input types (text, image). " +
      "Filter by provider key/display-name and/or model id/name to keep output small. " +
      "Set include_unauthenticated to true to also list models without configured credentials.",
    promptSnippet:
      "Search/models available AI models with auth status, context windows, and capabilities",
    promptGuidelines: [
      "Use list_models when the user asks which AI models are available, which providers are configured, or wants to compare model capabilities.",
      "Always provide model or provider filter when searching for specific models to avoid flooding context.",
    ],
    parameters: Type.Object({
      provider: Type.Optional(
        Type.String({
          description:
            "Case-insensitive substring match against provider key (e.g. 'cursor', 'opencode') and display name. " +
            "Omitting this returns models from all providers.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Case-insensitive substring match against model id and display name (e.g. 'deepseek', 'claude', 'gpt-5.4'). " +
            "Omitting this returns all models for the matched provider(s).",
        }),
      ),
      include_unauthenticated: Type.Optional(
        Type.Boolean({
          description:
            "When true, include models that do NOT have API keys or OAuth configured. Default: false (only show models with auth).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const includeAll = params.include_unauthenticated === true;
      const providerFilter = params.provider?.trim().toLowerCase();
      const modelFilter = params.model?.trim().toLowerCase();

      let models = includeAll
        ? ctx.modelRegistry.getAll()
        : ctx.modelRegistry.getAvailable();

      // Apply fuzzy filters
      if (providerFilter) {
        models = models.filter((m) => {
          const displayName =
            ctx.modelRegistry.getProviderDisplayName(m.provider).toLowerCase();
          return (
            m.provider.toLowerCase().includes(providerFilter) ||
            displayName.includes(providerFilter)
          );
        });
      }

      if (modelFilter) {
        models = models.filter(
          (m) =>
            m.id.toLowerCase().includes(modelFilter) ||
            m.name.toLowerCase().includes(modelFilter),
        );
      }

      if (models.length === 0) {
        const filters: string[] = [];
        if (providerFilter) filters.push(`provider="${params.provider}"`);
        if (modelFilter) filters.push(`model="${params.model}"`);
        const scope = includeAll ? "all registered" : "configured with auth";
        const filterNote = filters.length > 0 ? ` matching ${filters.join(" and ")}` : "";
        return {
          content: [
            {
              type: "text",
              text:
                `No ${scope} models found${filterNote}. ` +
                `Try broader filter terms or omit filters to list everything.`,
            },
          ],
          details: { models: [], count: 0, includeAll },
        };
      }

      // Group by provider
      const byProvider = new Map<
        string,
        {
          name: string;
          models: typeof models;
        }
      >();

      for (const m of models) {
        if (!byProvider.has(m.provider)) {
          byProvider.set(m.provider, {
            name: ctx.modelRegistry.getProviderDisplayName(m.provider),
            models: [],
          });
        }
        byProvider.get(m.provider)!.models.push(m);
      }

      // Build output
      const lines: string[] = [];
      const filters: string[] = [];
      if (providerFilter) filters.push(`provider matches "${params.provider}"`);
      if (modelFilter) filters.push(`model matches "${params.model}"`);
      const scope = includeAll ? "all registered" : "configured with auth (API key or OAuth)";
      const filterNote =
        filters.length > 0 ? ` — ${filters.join(" & ")}` : "";
      lines.push(`## Available Models (${scope}${filterNote})`);
      lines.push("");
      lines.push(`Total: **${models.length}** model(s) across **${byProvider.size}** provider(s)`);
      lines.push("");

      for (const [provider, group] of byProvider) {
        const label = group.name !== provider ? `${group.name} (${provider})` : provider;
        lines.push(`### ${label}`);
        lines.push("");

        for (const m of group.models) {
          const flags: string[] = [];
          if (m.reasoning) flags.push("reasoning");
          flags.push(m.input.includes("image") ? "text+image" : "text");

          lines.push(`- **${m.id}** — ${m.name}`);
          lines.push(`  - Context: ${m.contextWindow.toLocaleString()} tokens`);
          lines.push(`  - Max output: ${m.maxTokens.toLocaleString()} tokens`);
          lines.push(`  - Capabilities: ${flags.join(", ")}`);

          const costZero =
            m.cost.input === 0 &&
            m.cost.output === 0 &&
            m.cost.cacheRead === 0 &&
            m.cost.cacheWrite === 0;
          if (!costZero) {
            lines.push(
              `  - Cost (per 1M tokens): ` +
                `$${m.cost.input}/$${m.cost.output}` +
                (m.cost.cacheRead || m.cost.cacheWrite
                  ? ` (cache: $${m.cost.cacheRead} read / $${m.cost.cacheWrite} write)`
                  : ""),
            );
          }

          lines.push("");
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: models.length,
          providerCount: byProvider.size,
          includeAll,
          providerFilter: params.provider ?? null,
          modelFilter: params.model ?? null,
        },
      };
    },
  });
}
