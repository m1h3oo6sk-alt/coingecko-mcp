'use strict';

/**
 * Domain error codes used across the package.
 *
 * EINVALID   - caller-supplied input failed validation
 * EAPI       - CoinGecko API transport or response failure
 * ETIMEOUT   - request exceeded the configured timeout
 * ENOTFOUND  - a tracked asset or resource does not exist
 * ENOTINIT   - the local store has not been initialized yet
 * ECORRUPT   - a local data file failed to parse or validate
 * ENODATA    - a request succeeded but returned no usable rows
 * EFIXTURE   - the offline fixture is missing a required response
 * EFETCH     - no fetch implementation is available
 * EIO        - local file read/write failure
 */
const ERROR_CODES = Object.freeze({
  INVALID: 'EINVALID',
  API: 'EAPI',
  TIMEOUT: 'ETIMEOUT',
  NOT_FOUND: 'ENOTFOUND',
  NOT_INIT: 'ENOTINIT',
  CORRUPT: 'ECORRUPT',
  NO_DATA: 'ENODATA',
  FIXTURE: 'EFIXTURE',
  FETCH: 'EFETCH',
  IO: 'EIO',
});

class DomainError extends Error {
  constructor(message, code = 'EDOMAIN', details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.domain = true;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { DomainError, ERROR_CODES };
