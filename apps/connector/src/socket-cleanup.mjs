// Close the transport before releasing its SQL lease. Never erase credentials.
export async function closeSocketSession(socket, auth) {
  try {
    socket?.ev?.removeAllListeners('connection.update');
    socket?.end(undefined);
    await auth?.flush?.();
  } finally {
    await auth?.close?.();
  }
}
