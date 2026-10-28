// Reintento con backoff exponencial para fallos transitorios (Jira, SMTP).
// Solo reintenta si `isTransient(error)` dice que sí: un 400 de Jira (JQL
// inválido) o un destinatario rechazado no se arreglan reintentando.
async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, isTransient = () => true, label = 'operación' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransient(error)) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} falló (intento ${attempt}/${attempts}), reintentando en ${delay}ms: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

module.exports = { withRetry };
