import { ROOT_CONTEXT, trace, SpanKind, SpanStatusCode, type Attributes, type Context, type Meter, type Span, type SpanContext, type Tracer } from '@opentelemetry/api';
import type { SpanAttributes, TelemetryContext, TelemetryMetrics, TelemetrySpan } from '@earendil-works/pi-telemetry';

// The SDK's content-free telemetry vocabulary. Never forward prompts, tool
// arguments, responses, URLs, credentials or opaque reasoning/signatures.
const scalarKeys = new Set(['provider','model','api','reasoning','stop','type','index','chars','tool','kind','phase','attempt','resumed','outcome','result','reason','extension','task']);
function attributes(input: SpanAttributes = {}): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (!scalarKeys.has(key) && !/^(?:conversation|task|submission|entry|answer|tool|usage|response)\.(?:id|kind|name|type|entry_id|call_id|input|output|cache_read|cache_write|reasoning|total)$/.test(key) && key !== 'cost.total') continue;
    if (typeof value === 'string') out[key] = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256);
    else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
function observe<T>(body: () => T, fallback: T): T { try { return body(); } catch { return fallback; } }

/** A passive adapter for the public SDK telemetry contract. Export failures never
 * change SDK return values/errors, run a callback twice, or authorise execution. */
export function createOtelTelemetryContext(getTracer: () => Tracer, getMeter: () => Meter, enabled: () => boolean = () => true): TelemetrySpan {
  const parents = new WeakMap<object, Context>();
  const spanContext = (value: TelemetryContext): SpanContext | undefined => trace.getSpanContext(parents.get(value) ?? ROOT_CONTEXT);
  const telemetryMetrics: TelemetryMetrics = {
    counter(name, options) {
      return { add(value, attrs) { if (enabled()) observe(() => getMeter().createCounter(name, options).add(value, attributes(attrs)), undefined); } };
    },
    upDownCounter(name, options) {
      return { add(value, attrs) { if (enabled()) observe(() => getMeter().createUpDownCounter(name, options).add(value, attributes(attrs)), undefined); } };
    },
    histogram(name, options) {
      return { record(value, attrs, parent) { if (enabled()) observe(() => getMeter().createHistogram(name, { description: options?.description, unit: options?.unit,
        advice: options?.boundaries ? { explicitBucketBoundaries: [...options.boundaries] } : undefined }).record(value, attributes(attrs), parent ? parents.get(parent) : undefined), undefined); } };
    },
  };
  const propagation = {
    inject(value: TelemetryContext) {
      const parent = spanContext(value);
      return parent && trace.isSpanContextValid(parent) ? { traceparent: `00-${parent.traceId}-${parent.spanId}-${(parent.traceFlags & 1).toString(16).padStart(2, '0')}` } : undefined;
    },
    extract(carrier: Record<string, string> | undefined): TelemetryContext {
      const match = carrier?.traceparent?.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/);
      if (!match) return make(ROOT_CONTEXT);
      const parent: SpanContext = { traceId: match[1], spanId: match[2], traceFlags: parseInt(match[3], 16) & 1, isRemote: true };
      return make(trace.isSpanContextValid(parent) ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
    },
  };
  function make(parent: Context, span?: Span): TelemetrySpan {
    const adapter: TelemetrySpan = {
      metrics: telemetryMetrics,
      propagation,
      async startSpan(options, callback) {
        const links = options.links?.flatMap(link => {
          const context = spanContext(link.context);
          return context ? [{ context, attributes: attributes(link.attributes) }] : [];
        });
        const current = !enabled() ? undefined : observe(() => getTracer().startSpan(options.name.slice(0, 160), { kind: options.name === "pi.durable.submit" && options.attributes?.["submission.type"] === "input" ? SpanKind.SERVER : options.name.startsWith("pi.ai.") ? SpanKind.CLIENT : SpanKind.INTERNAL, attributes: attributes(options.attributes), links }, parent), undefined);
        const child = make(current ? trace.setSpan(parent, current) : parent, current);
        try {
          const value = await callback(child);
          return value;
        } catch (error) {
          observe(() => current?.setStatus({ code: SpanStatusCode.ERROR }), undefined);
          throw error;
        } finally { observe(() => current?.end(), undefined); }
      },
      addLink(link) {
        const context = spanContext(link.context);
        if (context) observe(() => span?.addLink({ context, attributes: attributes(link.attributes) }), undefined);
      },
      addEvent(name, attrs) { observe(() => span?.addEvent(name.slice(0, 160), attributes(attrs)), undefined); },
      setAttributes(attrs) { observe(() => span?.setAttributes(attributes(attrs)), undefined); },
      // SDK errors can include provider payloads. Keep status, not raw diagnostics;
      // Core's bounded private failure receipts remain the diagnostic source.
      setStatus(status) { observe(() => span?.setStatus({ code: status.status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR }), undefined); },
    };
    parents.set(adapter, parent);
    return adapter;
  }
  return make(ROOT_CONTEXT);
}
