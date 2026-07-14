// packages/controller/src/account.js
// The controller's main-process account service is the shared implementation
// (used by both apps). Re-exported here so main.js's local import path is stable.
export { createAccountService, DEFAULT_ACCOUNT_URL } from '@farsight/shared/account-service';
