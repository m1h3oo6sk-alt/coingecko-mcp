'use strict';

class DomainError extends Error {
  constructor(message, code = 'ECOINGECKO', details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.domain = true;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { DomainError };
