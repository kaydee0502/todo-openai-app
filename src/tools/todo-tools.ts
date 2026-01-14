import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Todo {
  id: string;
  item: string;
  isComplete: boolean;
  createdAt: string;
}

export const todos: Todo[] = [];
let nextId = 1;

export function listTodoItems(): Todo[] {
  return todos;
}

export function createTodoItem(item: string): Todo {
  const newTodo: Todo = {
    id: String(nextId++),
    item,
    isComplete: false,
    createdAt: new Date().toISOString(),
  };
  todos.push(newTodo);
  return newTodo;
}

export function updateTodoItem(id: string, isComplete: boolean): Todo | undefined {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return undefined;
  todo.isComplete = isComplete;
  return todo;
}

export function registerTodoResources(server: McpServer) {
  // Minimal widget template resource for OpenAI clients that try to fetch output templates via MCP resources/read.
  server.registerResource(
    "todoListTemplate",
    "ui://widget/TodoList.html",
    {
      title: "Todo list widget template",
      description: "UI template for rendering the todo list tool output.",
      mimeType: "text/html",
    },
    async (uri): Promise<any> => {
      const template = `<!doctype html>
<html>
  <body>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 12px; }
      main { border: 1px solid rgba(127,127,127,0.25); border-radius: 10px; padding: 12px; }
      h2 { margin: 0 0 10px; font-size: 1.05rem; }
      ul { margin: 0; padding-left: 18px; }
    </style>
    <main>
      <h2>Todos</h2>
      <!-- Client renders structuredContent.todos -->
    </main>
  </body>
</html>`;

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/html",
            text: template,
          },
        ],
      };
    }
  );
}

export function registerTodoTools(server: McpServer) {
  server.registerTool(
    "listTodos",
    {
      title: "List todos",
      description: "This will list all of my todos",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: {
        "openai/outputTemplate": "ui://widget/TodoList.html",
        "openai/toolInvocation/invoking": "Prepping your todo items",
        "openai/toolInvocation/invoked": "Here's your todo list",
        "openai/widgetAccessible": true,
      },
    },
    async (): Promise<any> => {
      const todos = listTodoItems();
      return {
        structuredContent: { todos },
        content: [
          {
            type: "text" as const,
            text: "The todo list:\n" + todos.map((t) => `- ${t.isComplete ? "[x]" : "[ ]"} ${t.item}`).join("\n"),
          },
        ],
      };
    }
  );

  server.registerTool(
    "createTodo",
    {
      title: "Create todo",
      description: "Create a new todo item",
      inputSchema: z.object({
        item: z.string().min(1).describe("The todo item text"),
      }),
      _meta: {
        "openai/widgetAccessible": true,
      },
    },
    async (args: any): Promise<any> => {
      const item = args.item;
      const newTodo = createTodoItem(item);

      return {
        content: [
          { type: "text" as const, text: `Created todo: ${JSON.stringify(newTodo, null, 2)}` },
        ],
      };
    }
  );

  server.registerTool(
    "updateTodo",
    {
      title: "Update todo",
      description: "Update a todo item (mark as complete)",
      inputSchema: z.object({
        id: z.string().min(1).describe("The ID of the todo to update"),
        isComplete: z.boolean().describe("Whether the todo is complete"),
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        "openai/widgetAccessible": true,
      },
    },
    async (args: any): Promise<any> => {
      const { id, isComplete } = args;
      const todo = updateTodoItem(id, isComplete);

      if (!todo) {
        return {
          content: [{ type: "text" as const, text: `Error: Todo with id ${id} not found` }],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text" as const, text: `Updated todo: ${JSON.stringify(todo, null, 2)}` },
        ],
      };
    }
  );
}
