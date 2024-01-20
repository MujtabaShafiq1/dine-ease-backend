import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';

import { UserDetails, StatusTypes, AdminRoles } from '@dine_ease/common';
import { RecordType } from 'src/enums/record.enum';

// Services
import { RedisService } from 'src/redis/redis.service';
import { S3Service } from 'src/services/aws-s3.service';
import { ModifyService } from 'src/modify/modify.service';
import { TwilioService } from 'src/services/twilio.service';
import { RecordsService } from 'src/records/records.service';

// Database
import { Model, Types } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { Restaurant, RestaurantDocument } from './models/restaurant.entity';

// NATS
import { Publisher } from '@nestjs-plugins/nestjs-nats-streaming-transport';
import {
  Subjects,
  RestaurantApprovedEvent,
  RestaurantUpdatedEvent,
  RestaurantDetailsUpdatedEvent,
  RestaurantDeletedEvent,
} from '@dine_ease/common';

// DTO
import { OtpDto } from './dto/otp.dto';
import { RestaurantIdDto } from './dto/mongo-id.dto';
import { RestaurantDto } from './dto/restaurant.dto';
import { RestaurantStatusDto } from './dto/status.dto';
import { DeleteImagesDto } from './dto/delete-images.dto';
import { PaginationDto } from './dto/pagination.dto';
import { PrimaryDetailsDto } from './dto/primary-details.dto';
import { RestaurantSlugDto } from './dto/slug.dto';

@Injectable()
export class RestaurantsService {
  constructor(
    private readonly publisher: Publisher,
    private readonly s3Service: S3Service,
    private readonly redisService: RedisService,
    private readonly twilioService: TwilioService,
    private readonly modifyService: ModifyService,
    private readonly recordsService: RecordsService,
    @InjectModel(Restaurant.name)
    private readonly restaurantModel: Model<RestaurantDocument>,
  ) {}

  // find restaurant by id
  async findRestaurantById(
    id: RestaurantIdDto,
    user?: UserDetails,
  ): Promise<RestaurantDocument> {
    const { restaurantId } = id;

    const found: RestaurantDocument = await this.restaurantModel.findOne({
      _id: restaurantId,
      isDeleted: false,
    });

    if (!found) {
      throw new NotFoundException('Restaurant not found');
    }

    if (user && found.userId !== user.id) {
      throw new UnauthorizedException('User is not authorized');
    }

    return found;
  }

  // find restaurant by slug
  async findRestaurantBySlug(
    restaurantSlugDto: RestaurantSlugDto,
  ): Promise<RestaurantDocument> {
    const { slug } = restaurantSlugDto;

    const found: RestaurantDocument = await this.restaurantModel.findOne({
      slug,
      isDeleted: false,
    });

    if (!found) throw new NotFoundException('Restaurant not found');
    return found;
  }

  // fetch all user slugs
  async getAllRestaurantSlugs(): Promise<RestaurantDocument[]> {
    const restaurants: RestaurantDocument[] = await this.restaurantModel
      .find({ status: StatusTypes.APPROVED })
      .select('slug');
    return restaurants;
  }

  // find duplicate data
  async findRestaurant(data: PrimaryDetailsDto, id?: string): Promise<void> {
    const { name, taxId } = data;
    const restaurantId = new Types.ObjectId(id);

    const query: any = { $or: [{ name }, { taxId }] };
    if (restaurantId) query._id = { $ne: restaurantId };

    const found: RestaurantDocument = await this.restaurantModel.findOne(query);
    if (found) throw new ConflictException('Restaurant already exists');
  }

  // get all restaurants
  async getAll(): Promise<RestaurantDocument[]> {
    const restaurants: RestaurantDocument[] = await this.restaurantModel.find();
    return restaurants;
  }

  // get approved restaurants
  async getUserRestaurants(user: UserDetails): Promise<RestaurantDocument[]> {
    const restaurants: RestaurantDocument[] = await this.restaurantModel.find({
      userId: user.id,
      isDeleted: false,
    });
    return restaurants;
  }

  // get approved restaurants
  async getApproved(
    paginationDto: PaginationDto,
  ): Promise<{ count?: number; restaurants: RestaurantDocument[] }> {
    let count: number;
    const { offset, limit } = paginationDto;

    if (offset == 0) {
      count = await this.getApprovedCount();
    }

    const restaurants: RestaurantDocument[] = await this.restaurantModel
      .find({ status: StatusTypes.APPROVED, isDeleted: false })
      .skip(offset)
      .limit(limit);

    return { count, restaurants };
  }

  // get approved restaurants count
  async getApprovedCount(): Promise<number> {
    return this.restaurantModel.countDocuments({
      status: StatusTypes.APPROVED,
      isDeleted: false,
    });
  }

  // get pending restaurants
  async getPending(): Promise<RestaurantDocument[]> {
    const restaurants: RestaurantDocument[] = await this.restaurantModel.find({
      status: StatusTypes.PENDING,
      isDeleted: false,
    });
    return restaurants;
  }

  // restaurant approval/rejection restaurant
  async restaurantStatus(
    idDto: RestaurantIdDto,
    user: UserDetails,
    restaurantDto: RestaurantStatusDto,
  ): Promise<string> {
    const { status, remarks } = restaurantDto;

    const found: RestaurantDocument = await this.findRestaurantById(idDto);

    if (found.status === StatusTypes.APPROVED) {
      throw new BadRequestException('Restaurant is already approved');
    }

    if (status === StatusTypes.APPROVED) {
      found.set({ status });
      await found.save();

      const { id, name, slug, taxId, cuisine, images, address, location } =
        found;
      const event: RestaurantApprovedEvent = {
        id,
        name,
        slug,
        taxId,
        cuisine,
        images,
        address,
        location,
      };

      this.publisher.emit<void, RestaurantApprovedEvent>(
        Subjects.RestaurantApproved,
        event,
      );
    } else {
      await found.deleteOne();
    }

    const payload = {
      adminId: String(user.id),
      restaurantId: String(found.id),
      status,
      type: RecordType.LISTING,
      remarks,
    };
    await this.recordsService.createRecord(payload);

    return 'Status Updated';
  }

  // upload restaurant images
  async uploadImages(
    idDto: RestaurantIdDto,
    files: Express.Multer.File[],
    user: UserDetails,
  ): Promise<string[]> {
    const found: RestaurantDocument = await this.findRestaurantById(
      idDto,
      user,
    );

    if (found.status !== StatusTypes.APPROVED) {
      throw new BadRequestException('Restaurant status should be approved');
    }

    if (found.images.length + files.length > 10) {
      throw new BadRequestException('Only 10 images are allowed');
    }

    const path = `${idDto.restaurantId}/images`;
    const results = await Promise.allSettled(
      files.map((file) => this.s3Service.upload(path, file)),
    );

    const successfulUploads = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        successfulUploads.push(result.value);
      }
    }

    found.images.push(...successfulUploads);
    await found.save();

    const event: RestaurantDetailsUpdatedEvent = {
      id: found.id,
      images: found.images,
      version: found.version,
    };

    this.publisher.emit<void, RestaurantDetailsUpdatedEvent>(
      Subjects.RestaurantDetailsUpdated,
      event,
    );

    return found.images;
  }

  // update avatar of user
  async uploadCover(
    idDto: RestaurantIdDto,
    user: UserDetails,
    file: Express.Multer.File,
  ): Promise<string> {
    const { restaurantId } = idDto;
    const found: RestaurantDocument = await this.findRestaurantById(
      idDto,
      user,
    );

    const path = `${restaurantId}/cover`;
    const deleteKey = found.cover;
    const newImage = await this.s3Service.upload(path, file);

    found.set({ cover: newImage });
    await found.save();

    if (deleteKey) {
      await this.s3Service.deleteOne(`${path}/${deleteKey}`);
    }

    return newImage;
  }

  // create a restaurant listing
  async createRestaurant(
    user: UserDetails,
    data: RestaurantDto,
  ): Promise<{ slug: string }> {
    await this.findRestaurant(data);
    await this.modifyService.findRestaurant(data);
    const { slug }: RestaurantDocument = await this.restaurantModel.create({
      userId: user.id,
      ...data,
    });
    return { slug };
  }

  // genrate OTP for verification of restaurant
  async generateOTP(
    idDto: RestaurantIdDto,
    user: UserDetails,
  ): Promise<{ ttl: number }> {
    const { restaurantId } = idDto;

    const found: RestaurantDocument = await this.findRestaurantById(
      idDto,
      user,
    );

    if (found.isVerified) {
      throw new BadRequestException('Restaurant is already verified');
    }

    // twilioService.sendOTP later
    const { ttl } = await this.redisService.cacheWrapper(
      restaurantId,
      120,
      async () => {
        return await this.twilioService.generateOTP();
      },
    );

    return { ttl };
  }

  // verify OTP of restaurant
  async verifyOTP(
    idDto: RestaurantIdDto,
    user: UserDetails,
    otpDto: OtpDto,
  ): Promise<string> {
    const { otp } = otpDto;
    const found: RestaurantDocument = await this.findRestaurantById(
      idDto,
      user,
    );

    if (found.isVerified) {
      throw new BadRequestException('Restaurant is already verified');
    }

    const cachedOTP = await this.redisService.getValue(found.id.toString());

    if (otp === cachedOTP) {
      found.set({ isVerified: true });
      await found.save();
      await this.redisService.deleteValue(found.id.toString());
      return 'OTP Verified';
    }

    throw new BadRequestException('Invalid OTP');
  }

  // update a restaurant
  async updateRestaurant(
    idDto: RestaurantIdDto,
    user: UserDetails,
    data: RestaurantDto,
  ): Promise<string> {
    const { name, taxId, address, cuisine, location, phoneNumber } = data;
    const found: RestaurantDocument = await this.findRestaurantById(
      idDto,
      user,
    );

    if (found.name !== name || found.taxId !== taxId) {
      // check uniqueness
      await this.modifyService.findRestaurant(data, idDto.restaurantId);
      await this.findRestaurant(data, idDto.restaurantId);

      if (found.status === StatusTypes.PENDING) {
        found.set({ name, taxId });
      } else {
        const payload = {
          userId: String(user.id),
          restaurantId: String(found.id),
          ...data,
        };
        await this.modifyService.createRequest(payload);
      }
    }

    if (found.phoneNumber !== data.phoneNumber) {
      found.set({ isVerified: false });
    }

    found.set({ address, cuisine, location, phoneNumber });
    await found.save();

    const event: RestaurantDetailsUpdatedEvent = {
      id: found.id,
      cuisine: found.cuisine,
      address: found.address,
      location: found.location,
      version: found.version,
    };

    this.publisher.emit<void, RestaurantDetailsUpdatedEvent>(
      Subjects.RestaurantDetailsUpdated,
      event,
    );

    return 'Restaurant Updated';
  }

  // approve update request
  async restaurantRequest(
    idDto: RestaurantIdDto,
    user: UserDetails,
    restaurantDto: RestaurantStatusDto,
  ): Promise<string> {
    const { status, remarks } = restaurantDto;

    const request = await this.modifyService.restaurantRequest(idDto);

    if (status === StatusTypes.APPROVED) {
      const found: RestaurantDocument = await this.findRestaurantById(idDto);
      const { taxId, name } = request;
      found.set({ taxId, name });
      await found.save();

      const event: RestaurantUpdatedEvent = {
        id: found.id,
        name: found.name,
        slug: found.slug,
        taxId: found.taxId,
        version: found.version,
      };

      this.publisher.emit<void, RestaurantUpdatedEvent>(
        Subjects.RestaurantUpdated,
        event,
      );
    }

    const payload = {
      adminId: String(user.id),
      restaurantId: String(request.restaurantId),
      status,
      type: RecordType.MODIFY,
      remarks,
    };
    await this.recordsService.createRecord(payload);

    await request.deleteOne();

    return 'Restaurant Updated';
  }

  // delete a restaurant
  async deleteRestaurant(
    idDto: RestaurantIdDto,
    user: UserDetails,
  ): Promise<string> {
    const found: RestaurantDocument = await this.findRestaurantById(idDto);

    if (found.userId === user.id || user.role === AdminRoles.ADMIN) {
      if (found.status === StatusTypes.APPROVED) {
        found.set({ isDeleted: true });
        await found.save();

        const event: RestaurantDeletedEvent = {
          id: found.id,
          version: found.version,
        };

        this.publisher.emit<void, RestaurantDeletedEvent>(
          Subjects.RestaurantDeleted,
          event,
        );
      } else {
        found.deleteOne();
      }
      return 'Restaurant Deleted';
    }

    throw new UnauthorizedException('User is not authorized');
  }

  // delete restaurant images
  async deleteImages(
    idDto: RestaurantIdDto,
    data: DeleteImagesDto,
    user: UserDetails,
  ): Promise<string> {
    const { images } = data;

    const found: RestaurantDocument = await this.findRestaurantById(
      idDto,
      user,
    );

    const path = `${idDto.restaurantId}/images`;
    await this.s3Service.deleteMany(path, images);

    const filteredImages = found.images.filter((v) => !images.includes(v));
    found.set({ images: filteredImages });
    await found.save();

    const event: RestaurantDetailsUpdatedEvent = {
      id: found.id,
      images: found.images,
      version: found.version,
    };

    this.publisher.emit<void, RestaurantDetailsUpdatedEvent>(
      Subjects.RestaurantDetailsUpdated,
      event,
    );

    return 'Image(s) Deleted';
  }
}
