import './config/load-environment';

import { NestFactory } from '@nestjs/core';
import { configureApp } from './configure-app';

export async function bootstrap() {
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

if (require.main === module) {
  void bootstrap();
}
