function createConversationOrchestrator(legacyChat) {
  if (!legacyChat || typeof legacyChat.send !== 'function' || typeof legacyChat.sendStream !== 'function') {
    throw new TypeError('legacyChat must provide send and sendStream functions');
  }

  return Object.freeze({
    send(input) {
      return legacyChat.send(input);
    },
    sendStream(input, emit) {
      return legacyChat.sendStream(input, emit);
    },
  });
}

module.exports = { createConversationOrchestrator };
