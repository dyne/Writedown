import { FormulaError } from './fragment.ts';
import type { FormulaRenderer } from './fragment.ts';
import { mathJaxEntry, mathJaxPath, mathJaxScripts, mathJaxVersion } from './mathjax-assets.ts';

interface MathJaxEngine {
  readonly version: string;
  readonly config: { readonly options: Record<string, unknown> };
  readonly startup: {
    readonly promise: Promise<void>;
    getInputJax(): unknown;
    getOutputJax(): unknown;
    readonly mathjax: {
      document(root: Document, options: Record<string, unknown>): {
        convertPromise(tex: string, options: { display: boolean }): Promise<HTMLElement>;
      };
    };
  };
}

const host = window as Window & { MathJax?: unknown };
let loading: Promise<MathJaxEngine> | undefined;

async function waitForCacheWorker() {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  const workers = navigator.serviceWorker;
  if (workers.controller) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      workers.removeEventListener('controllerchange', controlled);
      reject(new Error('The offline cache is not ready.'));
    }, 30_000);
    function controlled() {
      if (!workers.controller) return;
      window.clearTimeout(timeout);
      workers.removeEventListener('controllerchange', controlled);
      resolve();
    }
    workers.addEventListener('controllerchange', controlled);
    controlled();
  });
}

async function initialize(): Promise<MathJaxEngine> {
  await waitForCacheWorker();
  const root = new URL(import.meta.env.BASE_URL + mathJaxPath, location.origin);
  const integrity = new Map(Object.entries(mathJaxScripts).map(([path, hex]) => {
    const raw = hex.match(/../g)!.map(pair => String.fromCharCode(Number.parseInt(pair, 16))).join('');
    return [new URL(path, root).href, 'sha256-' + btoa(raw)];
  }));

  function loadScript(url: string) {
    return new Promise<void>((resolve, reject) => {
      const expected = integrity.get(url);
      if (!expected) {
        reject(new Error('MathJax requested an asset outside the pinned component set.'));
        return;
      }
      const script = document.createElement('script');
      script.src = url;
      script.integrity = expected;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('Could not load local MathJax.')); };
      document.head.append(script);
    });
  }

  return await new Promise<MathJaxEngine>((resolve, reject) => {
    host.MathJax = {
      loader: {
        paths: { mathjax: root.href.slice(0, -1), fonts: new URL('fonts', root).href },
        load: ['input/tex-base', '[tex]/ams', 'output/svg', 'ui/safe'],
        dependencies: { 'input/tex-base': ['core'], 'output/svg': ['core'], 'ui/safe': ['core'] },
        require: loadScript,
        failed: reject,
      },
      startup: { typeset: false },
      tex: {
        packages: ['base', 'ams', 'newcommand'],
        tags: 'none',
        formatError: (_jax: unknown, error: Error) => { throw new FormulaError(error.message); },
      },
      output: { font: 'mathjax-tex' },
      svg: { fontCache: 'none' },
      options: {
        safeOptions: { allow: { URLs: 'none', classes: 'none', cssIDs: 'none', styles: 'none' } },
        compileError: (_doc: unknown, _math: unknown, error: Error) => { throw error; },
        typesetError: (_doc: unknown, _math: unknown, error: Error) => { throw error; },
      },
    };
    void loadScript(new URL(mathJaxEntry, root).href).then(async () => {
      const engine = host.MathJax as MathJaxEngine | undefined;
      if (engine?.version !== mathJaxVersion || !engine.startup?.promise) {
        throw new Error('The pinned MathJax startup did not initialize.');
      }
      await engine.startup.promise;
      resolve(engine);
    }).catch(reject);
  });
}

function engine() {
  return loading ??= initialize().catch(() => {
    loading = undefined;
    throw new FormulaError('SVG renderer unavailable. Go online to load it, or choose KaTeX.');
  });
}

export const mathJaxRenderer: FormulaRenderer = {
  async render({ tex, displayMode, macroPreamble }, target) {
    const { startup, config } = await engine();
    // A new TeX input jax keeps selection and project definitions local to
    // this fragment, including global TeX definitions and equation labels.
    const fragment = startup.mathjax.document(document, {
      ...config.options,
      InputJax: startup.getInputJax(),
      OutputJax: startup.getOutputJax(),
    });
    const input = macroPreamble ? macroPreamble + '\n' + tex : tex;
    const rendered = await fragment.convertPromise(input, { display: displayMode });
    if (!rendered.querySelector('svg')) throw new FormulaError('MathJax did not produce an SVG.');
    rendered.setAttribute('role', 'img');
    rendered.setAttribute('aria-label', tex);
    target.replaceChildren(rendered);
  },
};
