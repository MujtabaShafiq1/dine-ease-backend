import { NestFactory } from '@nestjs/core';
import { MailModule } from './mail.module';

async function bootstrap() {
  const app = await NestFactory.create(MailModule);

  // server start
  const PORT = 3000;
  await app.listen(PORT);
}
bootstrap();
