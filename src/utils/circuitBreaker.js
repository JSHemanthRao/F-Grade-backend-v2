class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 30000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = 0;
  }

  canRequest() {
    if (this.state !== 'open') return true;
    if (Date.now() - this.openedAt < this.resetTimeoutMs) return false;
    this.state = 'half_open';
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  async execute(operation) {
    if (!this.canRequest()) {
      const error = new Error('CRM service is temporarily unavailable. Please retry shortly.');
      error.code = 'CRM_CIRCUIT_OPEN';
      error.statusCode = 503;
      throw error;
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (isTransientFailure(error)) this.recordFailure();
      throw error;
    }
  }
}

function isTransientFailure(error) {
  const status = error.response?.status || error.statusCode;
  return !status || status === 408 || status === 429 || status >= 500;
}

module.exports = { CircuitBreaker, isTransientFailure };
