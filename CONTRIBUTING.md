# Contributing to strix

First off, thank you for considering contributing to `strix`! It's people like you who make the open-source community such an amazing place to learn, inspire, and create.

To maintain a healthy codebase and smooth development flow, please read and follow these guidelines.

---

## Code of Conduct

Please be respectful and constructive in all issues, pull requests, and discussions.

## Getting Started

### Prerequisites

- **Bun**: You must have [Bun](https://bun.sh/) installed locally (version 1.0.0 or higher).
- **Playwright**: System dependencies for Playwright Chromium.

### Setup Instructions

1. **Fork the Repository** on GitHub.
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/<your-username>/strix.git
   cd strix
   ```
3. **Install dependencies**:
   ```bash
   bun install
   ```
4. **Install Playwright browsers**:
   ```bash
   npx playwright install chromium
   ```
5. **Set up environment variables**:
   ```bash
   cp .env.example .env
   ```
   Feel free to edit `.env` if you need to use a custom port or chrome path.

6. **Start the development server**:
   ```bash
   bun run dev
   ```

---

## Submitting a Pull Request

1. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b bugfix/your-bugfix-name
   ```
2. **Make your changes**. Keep them minimal, focused, and well-structured.
3. **Run the server** locally to verify everything works and there are no compilation or runtime errors.
4. **Commit your changes** with a descriptive commit message:
   ```bash
   git commit -m "feat: add support for custom user-agent config"
   ```
5. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```
6. **Open a Pull Request** (PR) against the main repository.

---

## Code Style Guidelines

- **Formatting**: We use standard TypeScript formatting.
- **Stealth and Scraped Requests**: Any changes to `BrowserProvider.ts` or `ScraperEngine.ts` should be thoroughly tested against target sites to ensure stealth properties are not degraded.
- **No Secrets**: Never commit `.env` files or custom `auth.json` configurations containing private credentials.

## Need Help?

If you find a bug or have a feature request, please open an issue using the appropriate template in the GitHub repository.
