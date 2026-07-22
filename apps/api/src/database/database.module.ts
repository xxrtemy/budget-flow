import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { DATABASE } from './database.constants';
import { createDatabase } from './database.factory';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createDatabase(config.getOrThrow<string>('DATABASE_URL')),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
