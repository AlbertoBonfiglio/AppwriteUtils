import { Databases, Storage, InputFile, Query, ID } from "node-appwrite";
import type { AppwriteConfig } from "./schema";
import path from "path";
import fs from "fs";

const getDatabaseFromConfig = (config: AppwriteConfig) => {
  return new Databases(config.appwriteClient!);
};

const getStorageFromConfig = (config: AppwriteConfig) => {
  return new Storage(config.appwriteClient!);
};

export interface AfterImportActions {
  [key: string]: (config: AppwriteConfig, ...args: any[]) => Promise<any>;
}

export const afterImportActions: AfterImportActions = {
  updateCreatedDocument: async (
    config: AppwriteConfig,
    dbId: string,
    collId: string,
    docId: string,
    data: any
  ) => {
    try {
      const db = getDatabaseFromConfig(config);
      await db.updateDocument(dbId, collId, docId, data);
    } catch (error) {
      console.error("Error updating document: ", error);
    }
  },
  checkAndUpdateFieldInDocument: async (
    config: AppwriteConfig,
    dbId: string,
    collId: string,
    docId: string,
    fieldName: string,
    oldFieldValue: any,
    newFieldValue: any
  ) => {
    try {
      const db = getDatabaseFromConfig(config);
      const doc = await db.getDocument(dbId, collId, docId);
      if (doc[fieldName as keyof typeof doc] == oldFieldValue) {
        await db.updateDocument(dbId, collId, docId, {
          [fieldName]: newFieldValue,
        });
      }
    } catch (error) {
      console.error("Error updating document: ", error);
    }
  },
  setFieldFromOtherCollectionDocument: async (
    config: AppwriteConfig,
    dbId: string,
    collIdOrName: string,
    docId: string,
    fieldName: string,
    otherCollIdOrName: string,
    otherDocId: string,
    otherFieldName: string
  ) => {
    const db = getDatabaseFromConfig(config);

    // Helper function to find a collection ID by name or return the ID if given
    const findCollectionId = async (collectionIdentifier: string) => {
      const collectionsPulled = await db.listCollections(dbId, [
        Query.limit(25),
        Query.equal("name", collectionIdentifier),
      ]);
      if (collectionsPulled.total > 0) {
        return collectionsPulled.collections[0].$id;
      } else {
        // Assuming the passed identifier might directly be an ID if not found by name
        return collectionIdentifier;
      }
    };

    try {
      // Resolve the IDs for both the target and other collections
      const targetCollectionId = await findCollectionId(collIdOrName);
      const otherCollectionId = await findCollectionId(otherCollIdOrName);

      // Retrieve the "other" document
      const otherDoc = await db.getDocument(
        dbId,
        otherCollectionId,
        otherDocId
      );
      const valueToSet = otherDoc[otherFieldName as keyof typeof otherDoc];

      if (valueToSet) {
        // Update the target document
        await db.updateDocument(dbId, targetCollectionId, docId, {
          [fieldName]: valueToSet,
        });
      }

      console.log(
        `Field ${fieldName} updated successfully in document ${docId}.`
      );
    } catch (error) {
      console.error(
        "Error setting field from other collection document: ",
        error
      );
    }
  },
  createOrGetBucket: async (
    config: AppwriteConfig,
    bucketName: string,
    bucketId?: string,
    permissions?: string[],
    fileSecurity?: boolean,
    enabled?: boolean,
    maxFileSize?: number,
    allowedExtensions?: string[],
    compression?: string,
    encryption?: boolean,
    antivirus?: boolean
  ) => {
    try {
      const storage = getStorageFromConfig(config);
      const bucket = await storage.listBuckets([
        Query.equal("name", bucketName),
      ]);
      if (bucket.buckets.length > 0) {
        return bucket.buckets[0];
      } else if (bucketId) {
        try {
          return await storage.getBucket(bucketId);
        } catch (error) {
          return await storage.createBucket(
            bucketId,
            bucketName,
            permissions,
            fileSecurity,
            enabled,
            maxFileSize,
            allowedExtensions,
            compression,
            encryption,
            antivirus
          );
        }
      } else {
        return await storage.createBucket(
          bucketId || ID.unique(),
          bucketName,
          permissions,
          fileSecurity,
          enabled,
          maxFileSize,
          allowedExtensions,
          compression,
          encryption,
          antivirus
        );
      }
    } catch (error) {
      console.error("Error creating or getting bucket: ", error);
    }
  },
  createFileAndUpdateField: async (
    config: AppwriteConfig,
    dbId: string,
    collId: string,
    docId: string,
    fieldName: string,
    bucketId: string,
    filePath: string,
    fileName: string
  ) => {
    try {
      const db = getDatabaseFromConfig(config);
      const storage = getStorageFromConfig(config);

      // Read the directory contents to find the file
      const files = fs.readdirSync(filePath);
      const fileFullName = files.find(
        (file) => file.startsWith(fileName) && path.extname(file)
      );

      if (!fileFullName) {
        throw new Error(
          `File starting with '${fileName}' not found in '${filePath}'`
        );
      }

      // Construct the full path for the file
      const fullFilePath = path.join(filePath, fileFullName);

      // Use the full file name (with extension) for creating the file
      const inputFile = InputFile.fromPath(fullFilePath, fileFullName);
      const file = await storage.createFile(bucketId, ID.unique(), inputFile);

      await db.updateDocument(dbId, collId, docId, {
        [fieldName]: file.$id,
      });
    } catch (error) {
      console.error("Error creating file and updating field: ", error);
    }
  },
};
