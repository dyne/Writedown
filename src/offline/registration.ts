type OfflineState = 'preparing' | 'waiting' | 'ready' | 'failed';
const statusText = {
  preparing: 'Preparing offline access…',
  waiting: 'The offline update is ready. Close Writedown tabs to apply it.',
  ready: 'Offline access is ready.',
  failed: 'Could not prepare offline access.',
};

export function mountOfflineStatus(parent: HTMLElement, base: string): void {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  const workers = navigator.serviceWorker;
  const scope = new URL(base, location.origin);
  const script = new URL('service-worker.js', scope);
  const container = document.createElement('div');
  container.className = 'offline-access';
  const status = document.createElement('p');
  status.id = 'offline-status';
  status.setAttribute('aria-live', 'polite');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry offline setup';
  container.append(status, retry);
  parent.append(container);

  function show(state: OfflineState, detail?: string) {
    status.dataset.state = state;
    status.textContent = detail ? `${statusText[state]} ${detail}` : statusText[state];
    retry.hidden = state !== 'failed';
  }

  const seenWorkers = new WeakSet<ServiceWorker>();
  const seenRegistrations = new WeakSet<ServiceWorkerRegistration>();
  function observe(registration: ServiceWorkerRegistration) {
    const attempt = registration.installing;
    if (attempt && !seenWorkers.has(attempt)) {
      seenWorkers.add(attempt);
      show('preparing');
      attempt.addEventListener('statechange', () => {
        if (attempt.state === 'installed' && workers.controller) show('waiting');
        if (attempt.state === 'redundant' && status.dataset.state === 'preparing') show('failed');
      });
    } else if (registration.waiting) {
      show('waiting');
    }
    if (!seenRegistrations.has(registration)) {
      seenRegistrations.add(registration);
      registration.addEventListener('updatefound', () => observe(registration));
    }
  }

  workers.addEventListener('controllerchange', () => {
    if (workers.controller?.scriptURL === script.href) show('ready');
  });
  workers.addEventListener('message', event => {
    if (!(event.source instanceof ServiceWorker) || event.source.scriptURL !== script.href) return;
    const { data } = event;
    if (data?.type !== 'writedown:offline') return;
    if (data.state === 'ready') show('ready');
    if (data.state === 'failed') show('failed', typeof data.detail === 'string' ? data.detail : undefined);
  });

  async function start(repair: boolean) {
    if (!workers.controller || repair) show('preparing');
    try {
      const registration = await workers.register(script, { scope: scope.href, updateViaCache: 'none' });
      observe(registration);
      if (repair && !registration.installing && !registration.waiting) {
        await registration.update();
        observe(registration);
        if (!registration.installing && !registration.waiting) {
          if (workers.controller) workers.controller.postMessage({ type: 'writedown:repair-offline' });
          else if (status.dataset.state === 'preparing') show('failed');
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      // An already controlled offline reload can open its verified app shell.
      if (!workers.controller || repair) show('failed', detail);
    }
  }

  retry.addEventListener('click', () => { void start(true); });
  show(workers.controller?.scriptURL === script.href ? 'ready' : 'preparing');
  void start(false);
}
