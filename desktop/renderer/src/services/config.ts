/**
 * Thin convenience re-export so pages can import the engine surface from one
 * place. `getEngineBase()` resolves the engine URL the shell exposes (cached;
 * falls back to http://127.0.0.1:3005 in a plain browser).
 */

export {
  resolveEngineBase as getEngineBase,
  invalidateEngineBase,
  EngineApiError,
  isSessionError,
  isNetworkError,
  apiGet,
  apiPost,
  apiDelete,
} from './engineApi'
