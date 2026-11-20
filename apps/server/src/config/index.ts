import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from server root or workspace root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

export interface ServerConfig {
  port: number;
  host: string;
  corsOrigin: string;
  nodeEnv: string;
  serviceName: string;
  version: string;
}

export const config: ServerConfig = {
  port: parseInt(process.env.PORT || '1234', 10),
  host: process.env.HOST || '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  nodeEnv: process.env.NODE_ENV || 'development',
  serviceName: 'HostelCode Collaboration Server',
  version: '0.1.0',
};
