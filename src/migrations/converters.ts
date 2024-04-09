import { DateTime } from "luxon";
import _ from "lodash";
import type { AppwriteConfig } from "./schema";

const { cloneDeep, isObject } = _;

export interface ConverterFunctions {
  [key: string]: (value: any) => any;
}

export const converterFunctions = {
  /**
   * Converts any value to a string. Handles null and undefined explicitly.
   * @param {any} value The value to convert.
   * @return {string | null} The converted string or null if the value is null or undefined.
   */
  anyToString(value: any): string | null {
    if (value == null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  },

  /**
   * Converts any value to a number. Returns null for non-numeric values, null, or undefined.
   * @param {any} value The value to convert.
   * @return {number | null} The converted number or null.
   */
  anyToNumber(value: any): number | null {
    if (value == null) return null;
    const number = Number(value);
    return isNaN(number) ? null : number;
  },

  /**
   * Converts any value to a boolean. Specifically handles string representations.
   * @param {any} value The value to convert.
   * @return {boolean | null} The converted boolean or null if conversion is not possible.
   */
  anyToBoolean(value: any): boolean | null {
    if (value == null) return null;
    if (typeof value === "string") {
      value = value.trim().toLowerCase();
      return value === "true" ? true : value === "false" ? false : null;
    }
    return Boolean(value);
  },

  /**
   * Converts any value to an array, attempting to split strings by a specified separator.
   * @param {any} value The value to convert.
   * @param {string | undefined} separator The separator to use when splitting strings.
   * @return {any[]} The resulting array after conversion.
   */
  anyToAnyArray(value: any): any[] {
    if (Array.isArray(value)) {
      return value.map((element) => converterFunctions.anyToString(element));
    } else if (typeof value === "string") {
      // Let's try a few
      return converterFunctions.trySplitByDifferentSeparators(value);
    }
    return [value];
  },

  /**
   * Tries to split a string by different separators and returns the split that has the most uniform segment lengths.
   * This can be particularly useful for structured data like phone numbers.
   * @param value The string to split.
   * @return The split string array that has the most uniform segment lengths.
   */
  trySplitByDifferentSeparators(value: string): string[] {
    const separators = [",", ";", "|", ":", "/", "\\"];
    let bestSplit: string[] = [];
    let highestUniformityScore = 0; // Higher score means more uniform lengths

    for (const separator of separators) {
      const split = value.split(separator);
      if (split.length <= 1) continue; // Skip if no actual splitting occurred

      // Calculate uniformity score for this split
      const lengths = split.map((segment) => segment.length);
      const averageLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const uniformityScore = lengths.reduce(
        (total, length) => total + Math.abs(length - averageLength),
        0
      );

      // A lower uniformityScore means lengths are more uniform
      // If this split has a more uniform length than the previous best, or if it's the first, update bestSplit
      if (bestSplit.length === 0 || uniformityScore < highestUniformityScore) {
        bestSplit = split;
        highestUniformityScore = uniformityScore;
      }
    }

    // If no suitable split was found, return the original value as a single-element array
    if (bestSplit.length === 0) {
      return [value];
    }

    return bestSplit;
  },

  /**
   * Tries to parse a date from various formats using Luxon with enhanced error reporting.
   * @param {string | number} input The input date as a string or timestamp.
   * @return {DateTime | null} The parsed Luxon DateTime object or null if parsing failed.
   */
  safeParseDate(input: string | number): DateTime | null {
    const formats = [
      "dd-LL-yyyy",
      "LL-dd-yyyy",
      "dd/LL/yyyy",
      "LL/dd/yyyy",
      "yyyy/LL/dd",
      "yyyy-LL-dd",
      "yyyy-MM-dd",
      "dd/MM/yyyy",
      "MM/dd/yyyy",
      "dd.MM.yyyy",
      "MM.dd.yyyy",
      "yyyy.MM.dd",
      "yyyy/MM/dd",
      "yyyy/MM/dd HH:mm:ss",
      "yyyy-MM-dd HH:mm:ss",
      "yyyy-MM-dd HH:mm:ss.SSS",
      "yyyy-MM-dd'T'HH:mm:ss.SSS",
      "yyyy-MM-dd'T'HH:mm:ss",
      "yyyy-MM-dd HH:mm",
    ];

    let date = DateTime.fromISO(String(input));
    if (!date.isValid)
      date = DateTime.fromMillis(
        typeof input === "number" ? input : parseInt(input)
      );
    if (!date.isValid) date = DateTime.fromSQL(String(input));
    formats.forEach((format) => {
      if (!date.isValid) {
        date = DateTime.fromFormat(String(input), format);
      }
    });

    if (!date.isValid) {
      console.error(`Failed to parse date from input: ${input}`);
      return null;
    }

    return date;
  },
};

/**
 * Deeply converts all properties of an object (or array) to strings.
 * @param data The input data to convert.
 * @returns The data with all its properties converted to strings.
 */
export const deepAnyToString = (data: any): any => {
  if (Array.isArray(data)) {
    return data.map((item) => deepAnyToString(item));
  } else if (isObject(data)) {
    return Object.keys(data).reduce((acc, key) => {
      acc[key] = deepAnyToString(data[key as keyof typeof data]);
      return acc;
    }, {} as Record<string, any>);
  } else {
    return converterFunctions.anyToString(data);
  }
};

/**
 * Performs a deep conversion of all values in a nested structure to the specified type.
 * Uses a conversion function like anyToString, anyToNumber, etc.
 * @param data The data to convert.
 * @param convertFn The conversion function to apply.
 * @returns The converted data.
 */
export const deepConvert = <T>(
  data: any,
  convertFn: (value: any) => T
): any => {
  if (Array.isArray(data)) {
    return data.map((item) => deepConvert(item, convertFn));
  } else if (isObject(data)) {
    return Object.keys(data).reduce((acc: Record<string, T>, key: string) => {
      acc[key] = deepConvert(data[key as keyof typeof data], convertFn);
      return acc;
    }, {});
  } else {
    return convertFn(data);
  }
};

/**
 * Converts an entire object's properties to different types based on a provided schema.
 * @param obj The object to convert.
 * @param schema A mapping of object keys to conversion functions.
 * @returns The converted object.
 */
export const convertObjectBySchema = (
  obj: Record<string, any>,
  schema: Record<string, (value: any) => any>
): Record<string, any> => {
  return Object.keys(obj).reduce((acc: Record<string, any>, key: string) => {
    const convertFn = schema[key];
    acc[key] = convertFn ? convertFn(obj[key]) : obj[key];
    return acc;
  }, {});
};

type AttributeMappings =
  AppwriteConfig["collections"][number]["importDefs"][number]["attributeMappings"];

/**
 * Converts the keys of an object based on a provided attributeMappings.
 * Each key in the object is checked against attributeMappings; if a matching entry is found,
 * the key is renamed to the targetKey specified in attributeMappings.
 *
 * @param obj The object to convert.
 * @param attributeMappings The attributeMappings defining how keys in the object should be converted.
 * @returns The converted object with keys renamed according to attributeMappings.
 */
export const convertObjectByAttributeMappings = (
  obj: Record<string, any>,
  attributeMappings: AttributeMappings
): Record<string, any> => {
  const result: Record<string, any> = {};

  // Iterate over the attributeMappings
  for (const mapping of attributeMappings) {
    if (mapping.oldKey in obj) {
      // If the oldKey is found in the input object, map it to the targetKey
      const { targetKey } = mapping;
      result[targetKey] = obj[mapping.oldKey];
    }
    // Removed the else clause to avoid adding keys that are not in the input object
  }

  return result;
};

/**
 * Ensures data conversion without mutating the original input.
 * @param data The data to convert.
 * @param convertFn The conversion function to apply.
 * @returns The converted data.
 */
export const immutableConvert = <T>(
  data: any,
  convertFn: (value: any) => T
): T => {
  const clonedData = cloneDeep(data);
  return convertFn(clonedData);
};

/**
 * Validates a string against a regular expression and returns the string if valid, or null.
 * @param value The string to validate.
 * @param pattern The regex pattern to validate against.
 * @returns The original string if valid, otherwise null.
 */
export const validateString = (
  value: string,
  pattern: RegExp
): string | null => {
  return pattern.test(value) ? value : null;
};
