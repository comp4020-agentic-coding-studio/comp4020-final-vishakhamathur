import type { WebSocket } from "ws";
import type { ServerMessage } from "./types.ts";

interface Connection {
  ws: WebSocket;
  analystId: string;
}

export class Hub {
  private connections = new Set<Connection>();

  add(ws: WebSocket, analystId: string): void {
    const connection: Connection = { ws, analystId };
    this.connections.add(connection);
    ws.on("close", () => this.connections.delete(connection));
  }

  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const connection of this.connections) {
      if (connection.ws.readyState === connection.ws.OPEN) connection.ws.send(data);
    }
  }
}
