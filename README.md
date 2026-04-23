# Python Project Setup

## Installation

1. Install dependencies:
   \`\`\`bash
   pip install -e .[dev]
   \`\`\`

2. Install pre-commit hooks:
   \`\`\`bash
   pre-commit install
   \`\`\`

## Running Tests

\`\`\`bash
pytest
\`\`\`

## Linting and Formatting

\`\`\`bash
ruff check src/
ruff format src/
mypy src/
\`\`\`
