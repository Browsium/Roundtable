# Persona Roundtable Frontend

Next.js 14 frontend for the Persona Roundtable marketing copy review tool.

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Features

- **Document Upload**: Drag-and-drop interface for PDF, DOCX, PPTX, TXT files
- **Panel Selection**: Choose which personas to include in the roundtable
- **Roundtable Dashboard**: View analysis results from each persona
- **Session History**: Browse past analyses
- **Persona Builder**: Create and edit custom personas
- **Real-time Updates**: Poll for analysis completion status
- **Error Handling**: Retry failed analyses

## Architecture

- **Next.js 14**: React framework with App Router
- **TypeScript**: Type safety throughout
- **Tailwind CSS**: Utility-first styling
- **Lucide React**: Modern icon library
- **Axios**: HTTP client for API communication
- **React Dropzone**: Drag-and-drop file uploads

## API Integration

Configure the API URL in `.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Routes

- `/` - Upload document and select panel
- `/sessions` - View session history
- `/sessions/[id]` - View session results
- `/personas` - Manage personas

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)