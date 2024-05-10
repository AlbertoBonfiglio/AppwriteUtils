import type { ImportDataActions } from "./importDataActions.js";
import {
  AttributeMappingsSchema,
  CollectionCreateSchema,
  importDefSchema,
  type AppwriteConfig,
  type AttributeMappings,
  type ConfigCollection,
  type ConfigDatabase,
  type IdMapping,
  type ImportDef,
  type ImportDefs,
  type RelationshipAttribute,
} from "appwrite-utils";
import path from "path";
import fs from "fs";
import { convertObjectByAttributeMappings } from "./converters.js";
import { z } from "zod";
import { checkForCollection } from "./collections.js";
import { ID, Users, type Databases } from "node-appwrite";
import { logger } from "./logging.js";
import { findOrCreateOperation, updateOperation } from "./migrationHelper.js";
import { AuthUserCreateSchema } from "../schemas/authUser.js";
import _ from "lodash";
import { UsersController } from "./users.js";
import { finalizeByAttributeMap } from "../utils/helperFunctions.js";
// Define a schema for the structure of collection import data using Zod for validation
export const CollectionImportDataSchema = z.object({
  // Optional collection creation schema
  collection: CollectionCreateSchema.optional(),
  // Array of data objects each containing rawData, finalData, context, and an import definition
  data: z.array(
    z.object({
      rawData: z.any(), // The initial raw data
      finalData: z.any(), // The transformed data ready for import
      context: z.any(), // Additional context for the data transformation
      importDef: importDefSchema.optional(), // The import definition schema
    })
  ),
});

// Infer the TypeScript type from the Zod schema
export type CollectionImportData = z.infer<typeof CollectionImportDataSchema>;

// DataLoader class to handle the loading of data into collections
export class DataLoader {
  // Private member variables to hold configuration and state
  private appwriteFolderPath: string;
  private importDataActions: ImportDataActions;
  private database: Databases;
  private usersController: UsersController;
  private config: AppwriteConfig;
  // Map to hold the import data for each collection by name
  importMap = new Map<string, CollectionImportData>();
  // Map to track old to new ID mappings for each collection, if applicable
  private oldIdToNewIdPerCollectionMap = new Map<string, Map<string, string>>();
  // Map to hold the import operation ID for each collection
  collectionImportOperations = new Map<string, string>();
  // Map to hold the merged user map for relationship resolution
  // Will hold an array of the old user ID's that are mapped to the same new user ID
  // For example, if there are two users with the same email, they will both be mapped to the same new user ID
  // Prevents duplicate users with the other two maps below it and allows me to keep the old ID's
  private mergedUserMap = new Map<string, string[]>();
  // Maps to hold email and phone to user ID mappings for unique-ness in User Accounts
  private emailToUserIdMap = new Map<string, string>();
  private phoneToUserIdMap = new Map<string, string>();
  userExistsMap = new Map<string, boolean>();
  private shouldWriteFile = false;

  // Constructor to initialize the DataLoader with necessary configurations
  constructor(
    appwriteFolderPath: string,
    importDataActions: ImportDataActions,
    database: Databases,
    config: AppwriteConfig,
    shouldWriteFile?: boolean
  ) {
    this.appwriteFolderPath = appwriteFolderPath;
    this.importDataActions = importDataActions;
    this.database = database;
    this.usersController = new UsersController(config, database);
    this.config = config;
    this.shouldWriteFile = shouldWriteFile || false;
  }

  // Helper method to generate a consistent key for collections
  getCollectionKey(name: string) {
    return name.toLowerCase().replace(" ", "");
  }

  /**
   * Merges two objects by updating the source object with the target object's values.
   * It iterates through the target object's keys and updates the source object if:
   * - The source object has the key.
   * - The target object's value for that key is not null, undefined, or an empty string.
   *
   * @param source - The source object to be updated.
   * @param target - The target object with values to update the source object.
   * @returns The updated source object.
   */
  mergeObjects(source: any, update: any): any {
    // Create a new object to hold the merged result
    const result = { ...source };

    Object.keys(update).forEach((key) => {
      const sourceValue = source[key];
      const updateValue = update[key];

      // If the update value is an array, concatenate and remove duplicates
      if (Array.isArray(updateValue)) {
        const sourceArray = Array.isArray(sourceValue) ? sourceValue : [];
        result[key] = [...new Set([...sourceArray, ...updateValue])];
      }
      // If the update value is an object, recursively merge
      else if (
        updateValue !== null &&
        typeof updateValue === "object" &&
        !(updateValue instanceof Date)
      ) {
        result[key] = this.mergeObjects(sourceValue, updateValue);
      }
      // If the update value is not nullish, overwrite the source value
      else if (updateValue !== null && updateValue !== undefined) {
        result[key] = updateValue;
      }
      // If the update value is nullish, keep the original value unless it doesn't exist
      else if (sourceValue === undefined) {
        result[key] = updateValue;
      }
    });

    return result;
  }

  // Method to load data from a file specified in the import definition
  loadData(importDef: ImportDef): any[] {
    // Resolve the file path and check if the file exists
    const filePath = path.resolve(this.appwriteFolderPath, importDef.filePath);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      return [];
    }

    // Read the file and parse the JSON data
    const rawData = fs.readFileSync(filePath, "utf8");
    return importDef.basePath
      ? JSON.parse(rawData)[importDef.basePath]
      : JSON.parse(rawData);
  }

  // Helper method to check if a new ID already exists in the old-to-new ID map
  checkMapValuesForId(newId: string, collectionName: string) {
    const oldIdMap = this.oldIdToNewIdPerCollectionMap.get(collectionName);
    for (const [key, value] of oldIdMap?.entries() || []) {
      if (value === newId) {
        return key;
      }
    }
    return false;
  }

  // Method to generate a unique ID that doesn't conflict with existing IDs
  getTrueUniqueId(collectionName: string) {
    let newId = ID.unique();
    while (this.checkMapValuesForId(newId, collectionName)) {
      newId = ID.unique();
    }
    return newId;
  }

  // Method to create a context object for data transformation
  createContext(
    db: ConfigDatabase,
    collection: ConfigCollection,
    item: any,
    docId: string
  ) {
    return {
      ...item, // Spread the item data for easy access to its properties
      dbId: db.$id,
      dbName: db.name,
      collId: collection.$id,
      collName: collection.name,
      docId: docId,
      createdDoc: {}, // Initially null, to be updated when the document is created
    };
  }

  /**
   * Transforms the given item based on the provided attribute mappings.
   * This method applies conversion rules to the item's attributes as defined in the attribute mappings.
   *
   * @param item - The item to be transformed.
   * @param attributeMappings - The mappings that define how each attribute should be transformed.
   * @returns The transformed item.
   */
  transformData(item: any, attributeMappings: AttributeMappings): any {
    // Convert the item using the attribute mappings provided
    const convertedItem = convertObjectByAttributeMappings(
      item,
      attributeMappings
    );
    // Run additional converter functions on the converted item, if any
    return this.importDataActions.runConverterFunctions(
      convertedItem,
      attributeMappings
    );
  }

  async setupMaps(dbId: string) {
    // Initialize the users collection in the import map
    this.importMap.set(this.getCollectionKey("users"), {
      data: [],
    });
    for (const db of this.config.databases) {
      if (db.$id !== dbId) {
        continue;
      }
      if (!this.config.collections) {
        continue;
      }
      for (let index = 0; index < this.config.collections.length; index++) {
        const collectionConfig = this.config.collections[index];
        let collection = CollectionCreateSchema.parse(collectionConfig);
        // Check if the collection exists in the database
        const collectionExists = await checkForCollection(
          this.database,
          db.$id,
          collection
        );
        if (!collectionExists) {
          logger.error(`No collection found for ${collection.name}`);
          continue;
        } else if (!collection.name) {
          logger.error(`Collection ${collection.name} has no name`);
          continue;
        }
        // Update the collection ID with the existing one
        collectionConfig.$id = collectionExists.$id;
        collection.$id = collectionExists.$id;
        this.config.collections[index] = collectionConfig;
        // Find or create an import operation for the collection
        const collectionImportOperation = await findOrCreateOperation(
          this.database,
          collection.$id,
          "importData"
        );
        // Store the operation ID in the map
        this.collectionImportOperations.set(
          this.getCollectionKey(collection.name),
          collectionImportOperation.$id
        );
        // Initialize the collection in the import map
        this.importMap.set(this.getCollectionKey(collection.name), {
          collection: collection,
          data: [],
        });
      }
    }
  }

  async getAllUsers() {
    const users = new UsersController(this.config, this.database);
    const allUsers = await users.getAllUsers();
    // Iterate over the users and setup our maps ahead of time for email and phone
    for (const user of allUsers) {
      if (user.email) {
        this.emailToUserIdMap.set(user.email, user.$id);
      }
      if (user.phone) {
        this.phoneToUserIdMap.set(user.phone, user.$id);
      }
      this.userExistsMap.set(user.$id, true);
    }
    return allUsers;
  }

  // Main method to start the data loading process for a given database ID
  async start(dbId: string) {
    console.log("---------------------------------");
    console.log(`Starting data setup for database: ${dbId}`);
    console.log("---------------------------------");
    await this.setupMaps(dbId);
    const allUsers = await this.getAllUsers();
    console.log(`Fetched ${allUsers.length} users`);
    // Iterate over the configured databases to find the matching one
    for (const db of this.config.databases) {
      if (db.$id !== dbId) {
        continue;
      }
      if (!this.config.collections) {
        continue;
      }
      // Iterate over the configured collections to process each
      for (const collectionConfig of this.config.collections) {
        const collection = collectionConfig;
        // Determine if this is the users collection
        let isUsersCollection =
          this.getCollectionKey(this.config.usersCollectionName) ===
          this.getCollectionKey(collection.name);
        // Process create and update definitions for the collection
        const createDefs = collection.importDefs.filter(
          (def: ImportDef) => def.type === "create" || !def.type
        );
        const updateDefs = collection.importDefs.filter(
          (def: ImportDef) => def.type === "update"
        );
        for (const createDef of createDefs) {
          if (!isUsersCollection) {
            console.log(`${collection.name} is not users collection`);
            await this.prepareCreateData(db, collection, createDef);
          } else {
            // Special handling for users collection if needed
            console.log(`${collection.name} is users collection`);
            await this.prepareUserCollectionCreateData(
              db,
              collection,
              createDef
            );
          }
        }
        for (const updateDef of updateDefs) {
          if (!this.importMap.has(this.getCollectionKey(collection.name))) {
            logger.error(
              `No data found for collection ${collection.name} for updateDef but it says it's supposed to have one...`
            );
            continue;
          }
          // Prepare the update data for the collection
          await this.prepareUpdateData(db, collection, updateDef);
        }
      }
      console.log("Running update references");
      await this.dealWithMergedUsers();
      await this.updateOldReferencesForNew();
      console.log("Done running update references");
    }
    // for (const collection of this.config.collections) {
    //   this.resolveDataItemRelationships(collection);
    // }
    console.log("---------------------------------");
    console.log(`Data setup for database: ${dbId} completed`);
    console.log("---------------------------------");
    if (this.shouldWriteFile) {
      this.writeMapsToJsonFile();
    }
  }

  async dealWithMergedUsers() {
    const usersCollectionKey = this.getCollectionKey(
      this.config.usersCollectionName
    );
    const usersCollectionPrimaryKeyFields = new Set();
    if (!this.config.collections) {
      return;
    }
    // Collect primary key fields from the users collection definitions
    this.config.collections.forEach((collection) => {
      if (this.getCollectionKey(collection.name) === usersCollectionKey) {
        collection.importDefs.forEach((importDef) => {
          if (importDef.primaryKeyField) {
            usersCollectionPrimaryKeyFields.add(importDef.primaryKeyField);
          }
        });
      }
    });

    // Iterate over all collections to update references based on merged users
    this.config.collections.forEach((collection) => {
      const collectionData = this.importMap.get(
        this.getCollectionKey(collection.name)
      );
      if (!collectionData || !collectionData.data) return;

      collection.importDefs.forEach((importDef) => {
        importDef.idMappings?.forEach((idMapping) => {
          if (
            this.getCollectionKey(idMapping.targetCollection) ===
            usersCollectionKey
          ) {
            if (usersCollectionPrimaryKeyFields.has(idMapping.targetField)) {
              // Process each item in the collection
              collectionData.data.forEach((item) => {
                const oldId = item.context[idMapping.sourceField];
                const newId = this.mergedUserMap.get(oldId);

                if (newId) {
                  // Update context to use new user ID
                  item.context[idMapping.fieldToSet || idMapping.targetField] =
                    newId;
                }
              });
            }
          }
        });
      });
    });
  }

  async updateOldReferencesForNew() {
    if (!this.config.collections) {
      return;
    }
    for (const collectionConfig of this.config.collections) {
      const collectionKey = this.getCollectionKey(collectionConfig.name);
      const collectionData = this.importMap.get(collectionKey);

      if (!collectionData || !collectionData.data) continue;

      console.log(
        `Updating references for collection: ${collectionConfig.name}`
      );

      let needsUpdate = false;

      // Iterate over each data item in the current collection
      for (let i = 0; i < collectionData.data.length; i++) {
        if (collectionConfig.importDefs) {
          for (const importDef of collectionConfig.importDefs) {
            if (importDef.idMappings) {
              for (const idMapping of importDef.idMappings) {
                const targetCollectionKey = this.getCollectionKey(
                  idMapping.targetCollection
                );
                const fieldToSetKey =
                  idMapping.fieldToSet || idMapping.sourceField;
                const valueToMatch =
                  collectionData.data[i].context[idMapping.sourceField];

                if (!valueToMatch || _.isEmpty(valueToMatch)) continue;

                const targetCollectionData =
                  this.importMap.get(targetCollectionKey);
                if (!targetCollectionData || !targetCollectionData.data)
                  continue;

                const foundData = targetCollectionData.data.filter((data) => {
                  const targetValue = data.context[idMapping.targetField];
                  const isMatch = `${targetValue}` === `${valueToMatch}`;
                  // Debugging output to understand what's being compared
                  logger.warn(
                    `Comparing target: ${targetValue} with match: ${valueToMatch} - Result: ${isMatch}`
                  );
                  return isMatch;
                });

                if (!foundData.length) {
                  console.log(
                    `No data found for collection: ${targetCollectionKey} with value: ${valueToMatch} for field: ${fieldToSetKey}`
                  );
                  logger.error(
                    `No data found for collection: ${targetCollectionKey} with value: ${valueToMatch} for field: ${fieldToSetKey} -- idMapping: ${JSON.stringify(
                      idMapping,
                      null,
                      2
                    )}`
                  );
                  continue;
                }

                needsUpdate = true;

                // Properly handle arrays and non-arrays
                if (
                  Array.isArray(collectionData.data[i].finalData[fieldToSetKey])
                ) {
                  collectionData.data[i].finalData[fieldToSetKey] =
                    foundData.map((data) => data.finalData);
                } else {
                  collectionData.data[i].finalData[fieldToSetKey] =
                    foundData[0].finalData;
                }
              }
            }
          }
        }
      }

      if (needsUpdate) {
        this.importMap.set(collectionKey, collectionData);
      }
    }
  }

  async updateReferencesInRelatedCollections() {
    if (!this.config.collections) {
      return;
    }
    // Iterate over each collection configuration
    for (const collectionConfig of this.config.collections) {
      const collectionKey = this.getCollectionKey(collectionConfig.name);
      const collectionData = this.importMap.get(collectionKey);

      if (!collectionData || !collectionData.data) continue;

      console.log(
        `Updating references for collection: ${collectionConfig.name}`
      );

      // Iterate over each data item in the current collection
      for (const item of collectionData.data) {
        let needsUpdate = false;

        // Check if the current collection has import definitions with idMappings
        if (collectionConfig.importDefs) {
          for (const importDef of collectionConfig.importDefs) {
            if (importDef.idMappings) {
              // Iterate over each idMapping defined for the current import definition
              for (const idMapping of importDef.idMappings) {
                const oldIds = Array.isArray(
                  item.context[idMapping.sourceField]
                )
                  ? item.context[idMapping.sourceField]
                  : [item.context[idMapping.sourceField]];
                const resolvedNewIds: string[] = [];

                oldIds.forEach((oldId: any) => {
                  // Attempt to find a new ID for the old ID
                  let newIdForOldId = this.findNewIdForOldId(
                    oldId,
                    idMapping,
                    importDef
                  );

                  if (
                    newIdForOldId &&
                    !resolvedNewIds.includes(newIdForOldId)
                  ) {
                    resolvedNewIds.push(newIdForOldId);
                  } else {
                    logger.error(
                      `No new ID found for old ID ${oldId} in collection ${collectionConfig.name}`
                    );
                  }
                });

                if (resolvedNewIds.length) {
                  const targetField =
                    idMapping.fieldToSet || idMapping.targetField;
                  const isArray = collectionConfig.attributes.some(
                    (attribute) =>
                      attribute.key === targetField && attribute.array
                  );

                  // Set the target field based on whether it's an array or single value
                  item.finalData[targetField] = isArray
                    ? resolvedNewIds
                    : resolvedNewIds[0];
                  needsUpdate = true;
                }
              }
            }
          }
        }

        // Update the importMap if changes were made to the item
        if (needsUpdate) {
          this.importMap.set(collectionKey, collectionData);
          logger.info(
            `Updated item: ${JSON.stringify(item.finalData, undefined, 2)}`
          );
        }
      }
    }
  }

  findNewIdForOldId(oldId: string, idMapping: IdMapping, importDef: ImportDef) {
    // First, check if this ID mapping is related to the users collection.
    const targetCollectionKey = this.getCollectionKey(
      idMapping.targetCollection
    );
    const isUsersCollection =
      targetCollectionKey ===
      this.getCollectionKey(this.config.usersCollectionName);

    // If handling users, check the mergedUserMap for any existing new ID.
    if (isUsersCollection) {
      for (const [newUserId, oldIds] of this.mergedUserMap.entries()) {
        if (oldIds.includes(oldId)) {
          return newUserId;
        }
      }
    }

    // If not a user or no merged ID found, check the regular ID mapping from old to new.
    const targetCollectionData = this.importMap.get(targetCollectionKey);
    if (targetCollectionData) {
      const foundEntry = targetCollectionData.data.find(
        (entry) => entry.context[importDef.primaryKeyField] === oldId
      );
      if (foundEntry) {
        return foundEntry.context.docId; // Assuming `docId` stores the new ID after import
      }
    }

    logger.error(
      `No corresponding new ID found for ${oldId} in ${targetCollectionKey}`
    );
    return null; // Return null if no new ID is found
  }

  private writeMapsToJsonFile() {
    const outputDir = path.resolve(process.cwd());
    const outputFile = path.join(outputDir, "dataLoaderOutput.json");

    const dataToWrite = {
      // Convert Maps to arrays of entries for serialization
      oldIdToNewIdPerCollectionMap: Array.from(
        this.oldIdToNewIdPerCollectionMap.entries()
      ).map(([key, value]) => {
        return {
          collection: key,
          data: Array.from(value.entries()),
        };
      }),
      mergedUserMap: Array.from(this.mergedUserMap.entries()),
      dataFromCollections: Array.from(this.importMap.entries()).map(
        ([key, value]) => {
          return {
            collection: key,
            data: value.data.map((item: any) => item.finalData),
          };
        }
      ),
      // emailToUserIdMap: Array.from(this.emailToUserIdMap.entries()),
      // phoneToUserIdMap: Array.from(this.phoneToUserIdMap.entries()),
    };

    // Use JSON.stringify with a replacer function to handle Maps
    const replacer = (key: any, value: any) => {
      if (value instanceof Map) {
        return Array.from(value.entries());
      }
      return value;
    };

    fs.writeFile(
      outputFile,
      JSON.stringify(dataToWrite, replacer, 2),
      "utf8",
      (err) => {
        if (err) {
          console.error("Error writing data to JSON file:", err);
          return;
        }
        console.log(`Data successfully written to ${outputFile}`);
      }
    );
  }

  /**
   * Prepares user data by checking for duplicates based on email or phone, adding to a duplicate map if found,
   * and then returning the transformed item without user-specific keys.
   *
   * @param item - The raw item to be processed.
   * @param attributeMappings - The attribute mappings for the item.
   * @returns The transformed item with user-specific keys removed.
   */
  async prepareUserData(
    item: any,
    attributeMappings: AttributeMappings,
    primaryKeyField: string,
    newId: string
  ): Promise<any> {
    // Transform the item data based on the attribute mappings
    let transformedItem = this.transformData(item, attributeMappings);
    const userData = AuthUserCreateSchema.safeParse(transformedItem);
    if (!userData.success) {
      logger.error(
        `Invalid user data: ${JSON.stringify(
          userData.error.errors,
          undefined,
          2
        )}`
      );
      return transformedItem;
    }
    const email = userData.data.email;
    const phone = userData.data.phone;
    let existingId: string | undefined;

    // Check for duplicate email and add to emailToUserIdMap if not found
    if (email && email.length > 0) {
      if (this.emailToUserIdMap.has(email)) {
        existingId = this.emailToUserIdMap.get(email);
      } else {
        this.emailToUserIdMap.set(email, newId);
      }
    }

    // Check for duplicate phone and add to phoneToUserIdMap if not found
    if (phone && phone.length > 0) {
      if (this.phoneToUserIdMap.has(phone)) {
        existingId = this.phoneToUserIdMap.get(phone);
      } else {
        this.phoneToUserIdMap.set(phone, newId);
      }
    }
    if (!existingId) {
      existingId = newId;
    }

    // If existingId is found, add to mergedUserMap
    if (existingId) {
      userData.data.userId = existingId;
      const mergedUsers = this.mergedUserMap.get(existingId) || [];
      mergedUsers.push(`${item[primaryKeyField]}`);
      this.mergedUserMap.set(existingId, mergedUsers);
    }

    // Remove user-specific keys from the transformed item
    const userKeys = ["email", "phone", "name", "labels", "prefs"];
    userKeys.forEach((key) => {
      if (transformedItem.hasOwnProperty(key)) {
        delete transformedItem[key];
      }
    });
    const usersMap = this.importMap.get(this.getCollectionKey("users"));
    const userDataToAdd = {
      rawData: item,
      finalData: userData.data,
    };
    // Directly update the importMap with the new user data, without pushing to usersMap.data first
    this.importMap.set(this.getCollectionKey("users"), {
      data: [...(usersMap?.data || []), userDataToAdd],
    });

    return [transformedItem, existingId, userDataToAdd];
  }

  /**
   * Prepares the data for creating user collection documents.
   * This involves loading the data, transforming it according to the import definition,
   * and handling the creation of new unique IDs for each item.
   *
   * @param db - The database configuration.
   * @param collection - The collection configuration.
   * @param importDef - The import definition containing the attribute mappings and other relevant info.
   */
  async prepareUserCollectionCreateData(
    db: ConfigDatabase,
    collection: ConfigCollection,
    importDef: ImportDef
  ): Promise<void> {
    // Load the raw data based on the import definition
    const rawData = this.loadData(importDef);
    const operationId = this.collectionImportOperations.get(
      this.getCollectionKey(collection.name)
    );
    // Initialize a new map for old ID to new ID mappings
    const oldIdToNewIdMap = new Map<string, string>();
    // Retrieve or initialize the collection-specific old ID to new ID map
    const collectionOldIdToNewIdMap =
      this.oldIdToNewIdPerCollectionMap.get(
        this.getCollectionKey(collection.name)
      ) ||
      this.oldIdToNewIdPerCollectionMap
        .set(this.getCollectionKey(collection.name), oldIdToNewIdMap)
        .get(this.getCollectionKey(collection.name));
    console.log(
      `${collection.name} -- collectionOldIdToNewIdMap: ${collectionOldIdToNewIdMap}`
    );
    if (!operationId) {
      throw new Error(
        `No import operation found for collection ${collection.name}`
      );
    }
    await updateOperation(this.database, operationId, {
      status: "ready",
      total: rawData.length,
    });
    // Retrieve the current user data and the current collection data from the import map
    const currentUserData = this.importMap.get(this.getCollectionKey("users"));
    const currentData = this.importMap.get(
      this.getCollectionKey(collection.name)
    );
    // Log errors if the necessary data is not found in the import map
    if (!currentUserData) {
      logger.error(
        `No data found for collection ${"users"} for createDef but it says it's supposed to have one...`
      );
      return;
    } else if (!currentData) {
      logger.error(
        `No data found for collection ${collection.name} for createDef but it says it's supposed to have one...`
      );
      return;
    }
    // Iterate through each item in the raw data
    for (const item of rawData) {
      // Prepare user data, check for duplicates, and remove user-specific keys
      let [transformedItem, existingId, userData] = await this.prepareUserData(
        item,
        importDef.attributeMappings,
        importDef.primaryKeyField,
        this.getTrueUniqueId(this.getCollectionKey("users"))
      );

      logger.info(
        `In create user -- transformedItem: ${JSON.stringify(
          transformedItem,
          null,
          2
        )}`
      );

      // Generate a new unique ID for the item or use existing ID
      if (!existingId) {
        // No existing user ID, generate a new unique ID
        existingId = this.getTrueUniqueId(this.getCollectionKey("users"));
        transformedItem.userId = existingId; // Assign the new ID to the transformed data's userId field
      }

      // Create a context object for the item, including the new ID
      let context = this.createContext(db, collection, item, existingId);

      // Merge the transformed data into the context
      context = { ...context, ...transformedItem };

      // If a primary key field is defined, handle the ID mapping and check for duplicates
      if (importDef.primaryKeyField) {
        const oldId = item[importDef.primaryKeyField];

        // Check if the oldId already exists to handle potential duplicates
        if (
          this.oldIdToNewIdPerCollectionMap
            .get(this.getCollectionKey(collection.name))
            ?.has(`${oldId}`)
        ) {
          // Found a duplicate oldId, now decide how to merge or handle these duplicates
          for (const data of currentData.data) {
            if (
              data.finalData.docId === oldId ||
              data.finalData.userId === oldId
            ) {
              transformedItem = this.mergeObjects(
                data.finalData,
                transformedItem
              );
            }
          }
        } else {
          // No duplicate found, simply map the oldId to the new itemId
          collectionOldIdToNewIdMap?.set(`${oldId}`, `${existingId}`);
        }
      }
      // Merge the final user data into the context
      context = { ...context, ...userData.finalData };

      // Handle merging for currentUserData
      for (let i = 0; i < currentUserData.data.length; i++) {
        if (
          (currentUserData.data[i].finalData.docId === existingId ||
            currentUserData.data[i].finalData.userId === existingId) &&
          !_.isEqual(currentUserData.data[i], userData)
        ) {
          this.mergeObjects(
            currentUserData.data[i].finalData,
            userData.finalData
          );
          console.log("Merging user data", currentUserData.data[i].finalData);
          this.importMap.set(this.getCollectionKey("users"), currentUserData);
        }
      }
      // Update the attribute mappings with any actions that need to be performed post-import
      const mappingsWithActions = this.getAttributeMappingsWithActions(
        importDef.attributeMappings,
        context,
        transformedItem
      );
      // Update the import definition with the new attribute mappings
      const newImportDef = {
        ...importDef,
        attributeMappings: mappingsWithActions,
      };

      let foundData = false;
      for (let i = 0; i < currentData.data.length; i++) {
        if (
          currentData.data[i].finalData.docId === existingId ||
          currentData.data[i].finalData.userId === existingId
        ) {
          currentData.data[i].finalData = this.mergeObjects(
            currentData.data[i].finalData,
            transformedItem
          );
          currentData.data[i].context = context;
          currentData.data[i].importDef = newImportDef;
          this.importMap.set(
            this.getCollectionKey(collection.name),
            currentData
          );
          this.oldIdToNewIdPerCollectionMap.set(
            this.getCollectionKey(collection.name),
            collectionOldIdToNewIdMap!
          );
          foundData = true;
        }
      }
      if (!foundData) {
        // Add new data to the associated collection
        currentData.data.push({
          rawData: item,
          context: context,
          importDef: newImportDef,
          finalData: transformedItem,
        });
        this.importMap.set(this.getCollectionKey(collection.name), currentData);
        this.oldIdToNewIdPerCollectionMap.set(
          this.getCollectionKey(collection.name),
          collectionOldIdToNewIdMap!
        );
      }
    }
  }

  /**
   * Prepares the data for creating documents in a collection.
   * This involves loading the data, transforming it, and handling ID mappings.
   *
   * @param db - The database configuration.
   * @param collection - The collection configuration.
   * @param importDef - The import definition containing the attribute mappings and other relevant info.
   */
  async prepareCreateData(
    db: ConfigDatabase,
    collection: ConfigCollection,
    importDef: ImportDef
  ): Promise<void> {
    // Load the raw data based on the import definition
    const rawData = this.loadData(importDef);
    const operationId = this.collectionImportOperations.get(
      this.getCollectionKey(collection.name)
    );
    if (!operationId) {
      throw new Error(
        `No import operation found for collection ${collection.name}`
      );
    }
    await updateOperation(this.database, operationId, {
      status: "ready",
      total: rawData.length,
    });
    // Initialize a new map for old ID to new ID mappings
    const oldIdToNewIdMapNew = new Map<string, string>();
    // Retrieve or initialize the collection-specific old ID to new ID map
    const collectionOldIdToNewIdMap =
      this.oldIdToNewIdPerCollectionMap.get(
        this.getCollectionKey(collection.name)
      ) ||
      this.oldIdToNewIdPerCollectionMap
        .set(this.getCollectionKey(collection.name), oldIdToNewIdMapNew)
        .get(this.getCollectionKey(collection.name));
    console.log(
      `${collection.name} -- collectionOldIdToNewIdMap: ${collectionOldIdToNewIdMap}`
    );
    // Iterate through each item in the raw data
    for (const item of rawData) {
      // Generate a new unique ID for the item
      const itemIdNew = this.getTrueUniqueId(
        this.getCollectionKey(collection.name)
      );
      // Retrieve the current collection data from the import map
      const currentData = this.importMap.get(
        this.getCollectionKey(collection.name)
      );
      // Create a context object for the item, including the new ID
      let context = this.createContext(db, collection, item, itemIdNew);
      // Transform the item data based on the attribute mappings
      const transformedData = this.transformData(
        item,
        importDef.attributeMappings
      );
      // If a primary key field is defined, handle the ID mapping and check for duplicates
      if (importDef.primaryKeyField) {
        const oldId = item[importDef.primaryKeyField];
        if (collectionOldIdToNewIdMap?.has(`${oldId}`)) {
          logger.error(
            `Collection ${collection.name} has multiple documents with the same primary key ${oldId}`
          );
          continue;
        }
        collectionOldIdToNewIdMap?.set(`${oldId}`, `${itemIdNew}`);
      }
      // Merge the transformed data into the context
      context = { ...context, ...transformedData };
      // Validate the item before proceeding
      const isValid = await this.importDataActions.validateItem(
        transformedData,
        importDef.attributeMappings,
        context
      );
      if (!isValid) {
        continue;
      }
      // Update the attribute mappings with any actions that need to be performed post-import
      const mappingsWithActions = this.getAttributeMappingsWithActions(
        importDef.attributeMappings,
        context,
        transformedData
      );
      // Update the import definition with the new attribute mappings
      const newImportDef = {
        ...importDef,
        attributeMappings: mappingsWithActions,
      };
      // If the current collection data exists, add the item with its context and final data
      if (currentData && currentData.data) {
        currentData.data.push({
          rawData: item,
          context: context,
          importDef: newImportDef,
          finalData: transformedData,
        });
        this.importMap.set(this.getCollectionKey(collection.name), currentData);
        this.oldIdToNewIdPerCollectionMap.set(
          this.getCollectionKey(collection.name),
          collectionOldIdToNewIdMap!
        );
      } else {
        logger.error(
          `No data found for collection ${collection.name} for createDef but it says it's supposed to have one...`
        );
        continue;
      }
    }
  }
  /**
   * Prepares the data for updating documents within a collection.
   * This method loads the raw data based on the import definition, transforms it according to the attribute mappings,
   * finds the new ID for each item based on the primary key or update mapping, and then validates the transformed data.
   * If the data is valid, it updates the import definition with any post-import actions and adds the item to the current collection data.
   *
   * @param db - The database configuration.
   * @param collection - The collection configuration.
   * @param importDef - The import definition containing the attribute mappings and other relevant info.
   */
  async prepareUpdateData(
    db: ConfigDatabase,
    collection: ConfigCollection,
    importDef: ImportDef
  ) {
    // Retrieve the current collection data and old-to-new ID map from the import map
    const currentData = this.importMap.get(
      this.getCollectionKey(collection.name)
    );
    const oldIdToNewIdMap = this.oldIdToNewIdPerCollectionMap.get(
      this.getCollectionKey(collection.name)
    );
    // Log an error and return if no current data is found for the collection
    if (
      !(currentData?.data && currentData?.data.length > 0) &&
      !oldIdToNewIdMap
    ) {
      logger.error(
        `No data found for collection ${collection.name} for updateDef but it says it's supposed to have one...`
      );
      return;
    }
    // Load the raw data based on the import definition
    const rawData = this.loadData(importDef);
    const operationId = this.collectionImportOperations.get(
      this.getCollectionKey(collection.name)
    );
    if (!operationId) {
      throw new Error(
        `No import operation found for collection ${collection.name}`
      );
    }
    for (const item of rawData) {
      // Transform the item data based on the attribute mappings
      let transformedData = this.transformData(
        item,
        importDef.attributeMappings
      );
      let newId: string | undefined;
      let oldId: string | undefined;
      // Determine the new ID for the item based on the primary key field or update mapping
      if (importDef.primaryKeyField) {
        oldId = item[importDef.primaryKeyField];
      } else if (importDef.updateMapping) {
        oldId = item[importDef.updateMapping.originalIdField];
      }
      if (oldId) {
        newId = oldIdToNewIdMap?.get(`${oldId}`);
        if (
          !newId &&
          this.getCollectionKey(this.config.usersCollectionName) ===
            this.getCollectionKey(collection.name)
        ) {
          for (const [key, value] of this.mergedUserMap.entries()) {
            if (value.includes(`${oldId}`)) {
              newId = key;
              break;
            }
          }
        }
      } else {
        logger.error(
          `No old ID found (to update another document with) in prepareUpdateData for ${
            collection.name
          }, ${JSON.stringify(item, null, 2)}`
        );
        continue;
      }
      // Log an error and continue to the next item if no new ID is found
      if (!newId) {
        logger.error(
          `No new id found for collection ${
            collection.name
          } for updateDef ${JSON.stringify(
            item,
            null,
            2
          )} but it says it's supposed to have one...`
        );
        continue;
      }
      const itemDataToUpdate = this.importMap
        .get(this.getCollectionKey(collection.name))
        ?.data.find(
          (data) => data.rawData[importDef.primaryKeyField] === oldId
        );
      if (!itemDataToUpdate) {
        logger.error(
          `No data found for collection ${
            collection.name
          } for updateDef ${JSON.stringify(
            item,
            null,
            2
          )} but it says it's supposed to have one...`
        );
        continue;
      }
      transformedData = this.mergeObjects(
        itemDataToUpdate.finalData,
        transformedData
      );
      // Create a context object for the item, including the new ID and transformed data
      let context = this.createContext(db, collection, item, newId);
      context = this.mergeObjects(context, transformedData);
      // Validate the item before proceeding
      const isValid = await this.importDataActions.validateItem(
        item,
        importDef.attributeMappings,
        context
      );
      // Log info and continue to the next item if it's invalid
      if (!isValid) {
        logger.info(
          `Skipping item: ${JSON.stringify(item, null, 2)} because it's invalid`
        );
        continue;
      }
      // Update the attribute mappings with any actions that need to be performed post-import
      const mappingsWithActions = this.getAttributeMappingsWithActions(
        importDef.attributeMappings,
        context,
        transformedData
      );
      // Update the import definition with the new attribute mappings
      const newImportDef = {
        ...importDef,
        attributeMappings: mappingsWithActions,
      };
      // Add the item with its context and final data to the current collection data
      if (itemDataToUpdate) {
        // Update the existing item's finalData and context in place
        itemDataToUpdate.finalData = this.mergeObjects(
          itemDataToUpdate.finalData,
          transformedData
        );
        itemDataToUpdate.context = context;
        itemDataToUpdate.importDef = newImportDef;
      } else {
        // If no existing item matches, then add the new item
        currentData!.data.push({
          rawData: item,
          context: context,
          importDef: newImportDef,
          finalData: transformedData,
        });
      }
      // Since we're modifying currentData in place, we ensure no duplicates are added
      this.importMap.set(this.getCollectionKey(collection.name), currentData!);
    }
  }

  private updateReferencesBasedOnAttributeMappings() {
    if (!this.config.collections) {
      return;
    }
    this.config.collections.forEach((collectionConfig) => {
      const collectionName = collectionConfig.name;
      const collectionData = this.importMap.get(
        this.getCollectionKey(collectionName)
      );

      if (!collectionData) {
        logger.error(`No data found for collection ${collectionName}`);
        return;
      }

      collectionData.data.forEach((dataItem) => {
        collectionConfig.importDefs.forEach((importDef) => {
          if (!importDef.idMappings) return; // Skip collections without idMappings
          importDef.idMappings.forEach((mapping) => {
            if (mapping && mapping.targetField) {
              const idsToUpdate = Array.isArray(
                dataItem[mapping.targetField as keyof typeof dataItem]
              )
                ? dataItem[mapping.targetField as keyof typeof dataItem]
                : [dataItem[mapping.targetField as keyof typeof dataItem]];
              const updatedIds = idsToUpdate.map((id: string) =>
                this.getMergedId(id, mapping.targetCollection)
              );

              // Update the dataItem with the new IDs
              dataItem[mapping.targetField as keyof typeof dataItem] =
                Array.isArray(
                  dataItem[mapping.targetField as keyof typeof dataItem]
                )
                  ? updatedIds
                  : updatedIds[0];
            }
          });
        });
      });
    });
  }

  private getMergedId(oldId: string, relatedCollectionName: string): string {
    // Retrieve the old to new ID map for the related collection
    const oldToNewIdMap = this.oldIdToNewIdPerCollectionMap.get(
      this.getCollectionKey(relatedCollectionName)
    );

    // If there's a mapping for the old ID, return the new ID
    if (oldToNewIdMap && oldToNewIdMap.has(`${oldId}`)) {
      return oldToNewIdMap.get(`${oldId}`)!; // The non-null assertion (!) is used because we checked if the map has the key
    }

    // If no mapping is found, return the old ID as a fallback
    return oldId;
  }

  /**
   * Generates attribute mappings with post-import actions based on the provided attribute mappings.
   * This method checks each mapping for a fileData attribute and adds a post-import action to create a file
   * and update the field with the file's ID if necessary.
   *
   * @param attributeMappings - The attribute mappings from the import definition.
   * @param context - The context object containing information about the database, collection, and document.
   * @param item - The item being imported, used for resolving template paths in fileData mappings.
   * @returns The attribute mappings updated with any necessary post-import actions.
   */
  getAttributeMappingsWithActions(
    attributeMappings: AttributeMappings,
    context: any,
    item: any
  ) {
    // Iterate over each attribute mapping to check for fileData attributes
    return attributeMappings.map((mapping) => {
      if (mapping.fileData) {
        // Resolve the file path using the provided template, context, and item
        let mappingFilePath = this.importDataActions.resolveTemplate(
          mapping.fileData.path,
          context,
          item
        );
        // Ensure the file path is absolute if it doesn't start with "http"
        if (!mappingFilePath.toLowerCase().startsWith("http")) {
          mappingFilePath = path.resolve(
            this.appwriteFolderPath,
            mappingFilePath
          );
        }
        // Define the after-import action to create a file and update the field
        const afterImportAction = {
          action: "createFileAndUpdateField",
          params: [
            "{dbId}",
            "{collId}",
            "{docId}",
            mapping.targetKey,
            `${this.config!.documentBucketId}_${context.dbName
              .toLowerCase()
              .replace(" ", "")}`, // Assuming 'images' is your bucket ID
            mappingFilePath,
            mapping.fileData.name,
          ],
        };
        // Add the after-import action to the mapping's postImportActions array
        const postImportActions = mapping.postImportActions
          ? [...mapping.postImportActions, afterImportAction]
          : [afterImportAction];
        return { ...mapping, postImportActions };
      }
      // Return the mapping unchanged if no fileData attribute is found
      return mapping;
    });
  }
}
