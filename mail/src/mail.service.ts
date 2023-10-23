import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  EmailTokenPayload,
  EmailTokenTypes,
  JwtMailService,
} from '@dine_ease/common';

// NATS
import { AccountCreatedEvent, AccountVerifiedEvent } from '@dine_ease/common';

// Database
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { User, UserDocument } from './models/user.entity';

// Services
import { MailerService } from '@nestjs-modules/mailer';

// DTO
import { EmailDto } from './dto/email.dto';

@Injectable()
export class MailService {
  constructor(
    private mailerService: MailerService,
    private jwtMailService: JwtMailService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  // send confirmation
  async sendConfirmation(
    email: string,
    name: string,
    subject: string,
  ): Promise<void> {
    const verifyPayload: EmailTokenPayload = {
      email,
      tokenType: EmailTokenTypes.ACCOUNT_VERIFY,
    };
    const verifyToken: string = this.jwtMailService.signToken(verifyPayload);

    await this.mailerService.sendMail({
      to: email,
      subject,
      template: './verification',
      context: {
        name,
        verificationLink: `http://localhost:3000/users/confirm?token=${verifyToken}`,
      },
    });
  }

  // register
  async register(user: AccountCreatedEvent): Promise<string> {
    const { authId, email, firstName, lastName } = user;
    const fullName = `${firstName} ${lastName}`;

    const found: UserDocument = await this.userModel.findOne({ email });
    if (found) throw new ConflictException('User already exist');
    await this.userModel.create({ authId, email });

    await this.sendConfirmation(
      email,
      fullName,
      'Verify your Email on LocalHost',
    );
    return 'Email verification sent';
  }

  // verify account
  async verifyAccount(data: AccountVerifiedEvent): Promise<void> {
    const found: UserDocument = await this.userModel.findOne({
      authId: data.authId,
    });
    if (!found) throw new NotFoundException('Account not found');
    found.set({ isVerified: true });
    await found.save();
  }

  // resend confirmation
  async resendConfirmation(emailDto: EmailDto): Promise<string> {
    const { email } = emailDto;

    const found: UserDocument = await this.userModel.findOne({ email });

    if (!found) throw new NotFoundException('User not found');
    if (found.isVerified)
      throw new BadRequestException('Account is already verified');

    await this.sendConfirmation(email, email, 'Verify your Email on LocalHost');
    return 'Email verification resent';
  }

  // resend email verification
  async forgotPassword(emailDto: EmailDto): Promise<string> {
    const { email } = emailDto;

    const found: UserDocument = await this.userModel.findOne({ email });
    if (!found) throw new NotFoundException('User not found');
    if (!found.isVerified)
      throw new BadRequestException('Account is not verified');

    const verifyPayload: EmailTokenPayload = {
      email,
      tokenType: EmailTokenTypes.UPDATE_PASSWORD,
    };
    const passwordToken: string = this.jwtMailService.signToken(verifyPayload);

    await this.mailerService.sendMail({
      to: email,
      subject: 'Update Password on LocalHost',
      template: './password-reset',
      context: {
        name: email,
        updateLink: `http://localhost:3000/users/update-password?token=${passwordToken}`,
      },
    });

    return 'Update password request sent';
  }
}
