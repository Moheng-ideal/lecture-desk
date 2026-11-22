import { handleApi } from './api.mjs';

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return handleApi(request, env, { hosted: true });
    }
    return env.ASSETS.fetch(request);
  },
};
