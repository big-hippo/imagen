# imagen

A lightweight self-hosted image workbench for OpenAI-compatible image APIs.

## Features

- Detects available image models from a compatible API endpoint
- Supports both text-to-image generation and image editing
- Polls async jobs and keeps local browser history
- Ships as a zero-dependency Node.js server with static frontend assets

## Getting Started

### Requirements

- Node.js 18+

### Run locally

```bash
npm start
```

By default the server listens on `127.0.0.1:3000`.

The default upstream image request timeout is `300000` ms (`UPSTREAM_IMAGE_TIMEOUT_MS`).

## Project Structure

```text
.
├── package.json
├── public/
│   ├── index.html
│   ├── studio.html
│   ├── script.js
│   ├── styles.css
│   └── generated/
└── server.js
```

## Notes

- Files under `public/generated/` are runtime-generated assets and are intentionally excluded from Git.
- Connection settings are stored in the browser only.

## License

MIT
