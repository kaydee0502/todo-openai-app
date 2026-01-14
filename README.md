# OpenAI MCP Server

A Model Context Protocol (MCP) server for OpenAI ChatGPT apps with integrated vector store capabilities and OAuth authentication.

## What is MCP?

The Model Context Protocol (MCP) is an open protocol that standardizes how applications provide context to LLMs. This server implements MCP to expose tools that ChatGPT can call.

## Features

This MCP server provides the following capabilities:

### Todo Management Tools
- **listTodos** - List all todos for the user
- **createTodo** - Create a new todo item
- **updateTodo** - Update a todo item (mark as complete)

### OpenAI Vector Store Tools
- **createVectorStore** - Create a new vector store for document storage
- **listVectorStores** - List all available vector stores
- **getVectorStore** - Get details of a specific vector store
- **deleteVectorStore** - Delete a vector store
- **addFilesToVectorStore** - Add files to an existing vector store
- **listVectorStoreFiles** - List files in a vector store
- **searchVectorStore** - Search through documents using natural language

### OAuth Authentication
- ChatGPT OAuth integration for secure user authentication
- Session management
- Protected API endpoints

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file (copy from `.env.example`):
```bash
cp .env.example .env
```

3. Configure your environment variables in `.env`:
   - `OPENAI_API_KEY` - Your OpenAI API key
   - `OAUTH_CLIENT_ID` - OAuth client ID from ChatGPT
   - `OAUTH_CLIENT_SECRET` - OAuth client secret
   - `SESSION_SECRET` - Secret for session encryption

4. Build the project:
```bash
npm run build
```

## Running the Server

### MCP Server (for tool calls)
```bash
npm start
```

### OAuth Server (for authentication)
```bash
npm run start:oauth
```

The OAuth server will run on `http://localhost:3000` by default.

## Development

To run in development mode with auto-recompilation:
```bash
npm run dev
```

## Configuration for OpenAI

To use this MCP server with OpenAI ChatGPT, you need to configure it in your OpenAI settings or application. The tutorial at https://gadget.dev/blog/how-to-build-your-first-chatgpt-app provides detailed instructions for:
Todo Management

#### listTodos
Returns all todos as JSON.

**Input:** None  
**Output:** Array of todo objects

#### createTodo
Creates a new todo item.

**Input:**
- `item` (string, required): The todo item text

**Output:** The created todo object

#### updateTodo
Updates a todo item's completion status.

**Input:**
- `id` (string, required): The ID of the todo to update
- `isComplete` (boolean, required): Whether the todo is complete

**Output:** The updated todo object

### Vector Store Management

#### createVectorStore
Creates a new OpenAI vector store for document storage and search.

**Input:**
- `name` (string, required): Name for the vector store
- `fileIds` (array, optional): Array of file IDs to add

**Output:** Created vector store object

#### listVectorStores
Lists all vector stores.

**Input:**
- `limit` (number, optional): Maximum results (default 20)

**Output:** Array of vector store objects

#### getVectorStore
Gets details of a specific vector store.

**Input:**
- `vectorStoreId` (string, required): Vector store ID

**Output:** Vector store object

#### deleteVectorStore
Deletes a vector store.

**Input:**
- `vectorStoreId` (string, required): Vector store ID

**Output:** Deletion confirmation

#### addFilesToVectorStore
Adds files to an existing vector store.

**Input:**
- `vectorStoreId` (string, required): Vector store ID
- `fileIds` (array, required): Array of file IDs

**Output:** File batch object

#### listVectorStoreFiles
Lists files in a vector store.

**Input:**
- `vectorStoreId` (string, required): Vector store ID
- `limit` (number, optional): Maximum results (default 20)

**Output:** Array of file objects

#### searchVectorStore
Searches through documents in a vector store using natural language.

**Input:**
- `vectorStoreId` (string, required): Vector store ID
- `query` (string, required): Search query
- `assistantId` (string, optional): Assistant ID for search

**Output:** Search results with messages
**Output:** Array of todo objects

### createTodo

Creates a new todo item.

**Input:**
- `item` (string, required): The todo item text

**Output:** The created todo object

### updateTodo

Updates a todo item's completion status.

**Input:**
- `id` (string, required): The ID of the todo to update
- `isComplete` (boolean, required): Whether the todo is complete

**Output:** The updated todo object

## Notes

- This is a basic implementation with in-memory storage
- For production use, integrate with a real database
- Follow the Gadget tutorial for full ChatGPT integration with OAuth and widgets
- The server uses stdio transport for communication with MCP clients

## Next Steps

To build a complete ChatGPT app:

1. Set up a Gadget app or your own backend with OAuth
2. Implement React widgets using `@openai/apps-sdk-ui`
3. Register your MCP server with ChatGPT
4. Add authentication and user management
5. Deploy your server

Refer to the tutorial for detailed guidance on these steps.
