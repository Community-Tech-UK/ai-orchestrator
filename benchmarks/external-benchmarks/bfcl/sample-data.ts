/**
 * Built-in fallback test cases for BFCL benchmark
 * Used when HuggingFace download fails
 */

import type { BFCLTestCase } from './types.js';

export const SAMPLE_TEST_CASES: BFCLTestCase[] = [
  {
    id: 'weather-1',
    question: 'What is the current weather in San Francisco in Celsius?',
    functions: [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
            units: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature units' }
          },
          required: ['city', 'units']
        }
      }
    ],
    groundTruth: {
      name: 'get_weather',
      arguments: { city: 'San Francisco', units: 'celsius' }
    }
  },
  {
    id: 'search-1',
    question: 'Search the web for "best restaurants in Tokyo" and return 5 results',
    functions: [
      {
        name: 'web_search',
        description: 'Search the web for a query',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            num_results: { type: 'integer', description: 'Number of results to return' }
          },
          required: ['query', 'num_results']
        }
      }
    ],
    groundTruth: {
      name: 'web_search',
      arguments: { query: 'best restaurants in Tokyo', num_results: 5 }
    }
  },
  {
    id: 'calculator-1',
    question: 'Calculate the value of (15 + 23) * 4',
    functions: [
      {
        name: 'calculate',
        description: 'Evaluate a mathematical expression',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Mathematical expression to evaluate' }
          },
          required: ['expression']
        }
      }
    ],
    groundTruth: {
      name: 'calculate',
      arguments: { expression: '(15 + 23) * 4' }
    }
  },
  {
    id: 'file-read-1',
    question: 'Read the contents of /home/user/config.json with UTF-8 encoding',
    functions: [
      {
        name: 'read_file',
        description: 'Read a file from the filesystem',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' },
            encoding: { type: 'string', enum: ['utf-8', 'ascii', 'base64'], description: 'File encoding' }
          },
          required: ['path', 'encoding']
        }
      }
    ],
    groundTruth: {
      name: 'read_file',
      arguments: { path: '/home/user/config.json', encoding: 'utf-8' }
    }
  },
  {
    id: 'database-1',
    question: 'Query the users database to find all active users',
    functions: [
      {
        name: 'query_database',
        description: 'Execute a SQL query on a database',
        parameters: {
          type: 'object',
          properties: {
            database: { type: 'string', description: 'Database name' },
            sql: { type: 'string', description: 'SQL query to execute' }
          },
          required: ['database', 'sql']
        }
      }
    ],
    groundTruth: {
      name: 'query_database',
      arguments: { database: 'users', sql: 'SELECT * FROM users WHERE status = \'active\'' }
    }
  },
  {
    id: 'email-1',
    question: 'Send an email to john@example.com with subject "Meeting Reminder" and body "Don\'t forget our meeting at 3pm"',
    functions: [
      {
        name: 'send_email',
        description: 'Send an email message',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address' },
            subject: { type: 'string', description: 'Email subject' },
            body: { type: 'string', description: 'Email body content' }
          },
          required: ['to', 'subject', 'body']
        }
      }
    ],
    groundTruth: {
      name: 'send_email',
      arguments: {
        to: 'john@example.com',
        subject: 'Meeting Reminder',
        body: 'Don\'t forget our meeting at 3pm'
      }
    }
  },
  {
    id: 'http-1',
    question: 'Make a GET request to https://api.github.com/users/octocat with Authorization header "Bearer token123"',
    functions: [
      {
        name: 'http_request',
        description: 'Make an HTTP request',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to request' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
            headers: { type: 'object', description: 'Request headers', additionalProperties: { type: 'string' } }
          },
          required: ['url', 'method']
        }
      }
    ],
    groundTruth: {
      name: 'http_request',
      arguments: {
        url: 'https://api.github.com/users/octocat',
        method: 'GET',
        headers: { 'Authorization': 'Bearer token123' }
      }
    }
  },
  {
    id: 'datetime-1',
    question: 'Get the current date and time in America/New_York timezone formatted as ISO 8601',
    functions: [
      {
        name: 'get_datetime',
        description: 'Get current date and time',
        parameters: {
          type: 'object',
          properties: {
            timezone: { type: 'string', description: 'IANA timezone name' },
            format: { type: 'string', enum: ['ISO 8601', 'unix', 'human-readable'], description: 'Output format' }
          },
          required: ['timezone', 'format']
        }
      }
    ],
    groundTruth: {
      name: 'get_datetime',
      arguments: { timezone: 'America/New_York', format: 'ISO 8601' }
    }
  },
  {
    id: 'translate-1',
    question: 'Translate "Hello, how are you?" from English to Spanish',
    functions: [
      {
        name: 'translate',
        description: 'Translate text between languages',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to translate' },
            source_lang: { type: 'string', description: 'Source language code (ISO 639-1)' },
            target_lang: { type: 'string', description: 'Target language code (ISO 639-1)' }
          },
          required: ['text', 'source_lang', 'target_lang']
        }
      }
    ],
    groundTruth: {
      name: 'translate',
      arguments: {
        text: 'Hello, how are you?',
        source_lang: 'en',
        target_lang: 'es'
      }
    }
  },
  {
    id: 'user-create-1',
    question: 'Create a new user with name "Alice Johnson", email "alice@company.com", and role "admin"',
    functions: [
      {
        name: 'create_user',
        description: 'Create a new user account',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Full name' },
            email: { type: 'string', description: 'Email address' },
            role: { type: 'string', enum: ['admin', 'user', 'guest'], description: 'User role' }
          },
          required: ['name', 'email', 'role']
        }
      }
    ],
    groundTruth: {
      name: 'create_user',
      arguments: {
        name: 'Alice Johnson',
        email: 'alice@company.com',
        role: 'admin'
      }
    }
  }
];
