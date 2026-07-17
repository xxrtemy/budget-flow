import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';
import { IANAZone } from 'luxon';

export function IsIanaTimezone(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => registerDecorator({
    name: 'isIanaTimezone',
    target: target.constructor,
    propertyName: propertyKey.toString(),
    options,
    validator: {
      validate: (value: unknown) => typeof value === 'string' && IANAZone.isValidZone(value),
      defaultMessage: (args: ValidationArguments) => `${args.property} must be a valid IANA timezone`,
    },
  });
}
