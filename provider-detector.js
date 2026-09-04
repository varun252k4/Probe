window.ProbeProviders = (() => {
  const providers = [];

  return {
    register(provider) {
      if (!provider?.id) return;
      providers.push(provider);
    },
    detect(settings) {
      return providers.find((provider) => provider.detect?.(settings)) || null;
    },
    all() {
      return [...providers];
    },
  };
})();
