import { toCamelCase, toPascalCase } from "../utils/index.js";
import type {
  AppwriteConfig,
  Attribute,
  RelationshipAttribute,
} from "./schema.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

interface RelationshipDetail {
  parentCollection: string;
  childCollection: string;
  parentKey: string;
  childKey: string;
  isArray: boolean;
  isChild: boolean;
}

export class SchemaGenerator {
  private relationshipMap = new Map<string, RelationshipDetail[]>();
  private config: AppwriteConfig;
  private appwriteFolderPath: string;

  constructor(config: AppwriteConfig, appwriteFolderPath: string) {
    this.config = config;
    this.appwriteFolderPath = appwriteFolderPath;
    this.extractRelationships();
  }

  private extractRelationships(): void {
    this.config.collections.forEach((collection) => {
      collection.attributes.forEach((attr) => {
        if (attr.type === "relationship" && attr.twoWay && attr.twoWayKey) {
          const relationshipAttr = attr as RelationshipAttribute;
          let isArrayParent = false;
          let isArrayChild = false;
          switch (relationshipAttr.relationType) {
            case "oneToMany":
              isArrayParent = true;
              isArrayChild = false;
              break;
            case "manyToMany":
              isArrayParent = true;
              isArrayChild = true;
              break;
            case "oneToOne":
              isArrayParent = false;
              isArrayChild = false;
              break;
            case "manyToOne":
              isArrayParent = false;
              isArrayChild = true;
              break;
            default:
              break;
          }
          this.addRelationship(
            collection.name,
            relationshipAttr.relatedCollection,
            attr.key,
            relationshipAttr.twoWayKey,
            isArrayParent,
            isArrayChild
          );
        }
      });
    });
  }

  private addRelationship(
    parentCollection: string,
    childCollection: string,
    parentKey: string,
    childKey: string,
    isArrayParent: boolean,
    isArrayChild: boolean
  ): void {
    const relationshipsChild = this.relationshipMap.get(childCollection) || [];
    const relationshipsParent =
      this.relationshipMap.get(parentCollection) || [];
    relationshipsParent.push({
      parentCollection,
      childCollection,
      parentKey,
      childKey,
      isArray: isArrayParent,
      isChild: false,
    });
    relationshipsChild.push({
      parentCollection,
      childCollection,
      parentKey,
      childKey,
      isArray: isArrayChild,
      isChild: true,
    });
    this.relationshipMap.set(childCollection, relationshipsChild);
    this.relationshipMap.set(parentCollection, relationshipsParent);
  }

  public generateSchemas(): void {
    this.config.collections.forEach((collection) => {
      const schemaString = this.createSchemaString(
        collection.name,
        collection.attributes
      );
      const camelCaseName = toCamelCase(collection.name);
      const schemaPath = path.join(
        this.appwriteFolderPath,
        "schemas",
        `${camelCaseName}.ts`
      );
      fs.writeFileSync(schemaPath, schemaString, { encoding: "utf-8" });
      console.log(`Schema written to ${schemaPath}`);
    });
  }

  createSchemaString = (name: string, attributes: Attribute[]): string => {
    const pascalName = toPascalCase(name);
    let imports = `import { z } from "zod";\n`;

    // Use the relationshipMap to find related collections
    const relationshipDetails = this.relationshipMap.get(name) || [];
    const relatedCollections = relationshipDetails.map((detail) => {
      const relatedCollectionName = detail.isChild
        ? detail.parentCollection
        : detail.childCollection;
      const key = detail.isChild ? detail.childKey : detail.parentKey;
      const isArray = detail.isArray ? "array" : "";
      return [relatedCollectionName, key, isArray];
    });

    let relatedTypes = "";
    let relatedTypesLazy = "";
    let curNum = 0;
    let maxNum = relatedCollections.length;
    relatedCollections.forEach((relatedCollection) => {
      const relatedPascalName = toPascalCase(relatedCollection[0]);
      const relatedCamelName = toCamelCase(relatedCollection[0]);
      curNum++;
      let endNameTypes = relatedPascalName;
      let endNameLazy = `${relatedPascalName}Schema`;
      if (relatedCollection[2] === "array") {
        endNameTypes += "[]";
        endNameLazy += ".array().default([])";
      } else if (!(relatedCollection[2] === "array")) {
        endNameTypes += " | null";
        endNameLazy += ".nullish()";
      }
      imports += `import { ${relatedPascalName}Schema, type ${relatedPascalName} } from "./${relatedCamelName}";\n`;
      relatedTypes += `${relatedCollection[1]}?: ${endNameTypes};\n`;
      if (relatedTypes.length > 0 && curNum !== maxNum) {
        relatedTypes += "  ";
      }
      relatedTypesLazy += `${relatedCollection[1]}: z.lazy(() => ${endNameLazy}),\n`;
      if (relatedTypesLazy.length > 0 && curNum !== maxNum) {
        relatedTypesLazy += "  ";
      }
    });

    let schemaString = `${imports}\n\n`;
    schemaString += `export const ${pascalName}SchemaBase = z.object({\n`;
    schemaString += `  $id: z.string().optional(),\n`;
    schemaString += `  $createdAt: z.date().or(z.string()).optional(),\n`;
    schemaString += `  $updatedAt: z.date().or(z.string()).optional(),\n`;
    for (const attribute of attributes) {
      if (attribute.type === "relationship") {
        continue;
      }
      schemaString += `  ${attribute.key}: ${this.typeToZod(attribute)},\n`;
    }
    schemaString += `});\n\n`;
    schemaString += `export type ${pascalName}Base = z.infer<typeof ${pascalName}SchemaBase>`;
    if (relatedTypes.length > 0) {
      schemaString += ` & {\n  ${relatedTypes}};\n\n`;
    } else {
      schemaString += `;\n\n`;
    }
    schemaString += `export const ${pascalName}Schema: z.ZodType<${pascalName}Base> = ${pascalName}SchemaBase`;
    if (relatedTypes.length > 0) {
      schemaString += `.extend({\n  ${relatedTypesLazy}});\n\n`;
    } else {
      schemaString += `;\n`;
    }
    schemaString += `export type ${pascalName} = z.infer<typeof ${pascalName}Schema>;\n\n`;

    return schemaString;
  };

  typeToZod = (attribute: Attribute) => {
    let baseSchemaCode = "";

    switch (attribute.type) {
      case "string":
        baseSchemaCode = "z.string()";
        if (attribute.size) {
          baseSchemaCode += `.max(${attribute.size}, "Maximum length of ${attribute.size} characters exceeded")`;
        }
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default("${attribute.xdefault}")`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "integer":
        baseSchemaCode = "z.number().int()";
        if (attribute.min !== undefined) {
          baseSchemaCode += `.min(${attribute.min}, "Minimum value of ${attribute.min} not met")`;
        }
        if (attribute.max !== undefined) {
          baseSchemaCode += `.max(${attribute.max}, "Maximum value of ${attribute.max} exceeded")`;
        }
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default(${attribute.xdefault})`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "float":
        baseSchemaCode = "z.number()";
        if (attribute.min !== undefined) {
          baseSchemaCode += `.min(${attribute.min}, "Minimum value of ${attribute.min} not met")`;
        }
        if (attribute.max !== undefined) {
          baseSchemaCode += `.max(${attribute.max}, "Maximum value of ${attribute.max} exceeded")`;
        }
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default(${attribute.xdefault})`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "boolean":
        baseSchemaCode = "z.boolean()";
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default(${attribute.xdefault})`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "datetime":
        baseSchemaCode = "z.date()";
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default(new Date("${attribute.xdefault}"))`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "email":
        baseSchemaCode = "z.string().email()";
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default("${attribute.xdefault}")`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "ip":
        baseSchemaCode = "z.string()"; // Add custom validation as needed
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default("${attribute.xdefault}")`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "url":
        baseSchemaCode = "z.string().url()";
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default("${attribute.xdefault}")`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "enum":
        baseSchemaCode = `z.enum([${attribute.elements
          .map((element) => `"${element}"`)
          .join(", ")}])`;
        if (attribute.xdefault !== undefined) {
          baseSchemaCode += `.default("${attribute.xdefault}")`;
        }
        if (!attribute.required && !attribute.array) {
          baseSchemaCode += ".nullish()";
        }
        break;
      case "relationship":
        break;
      default:
        baseSchemaCode = "z.any()";
    }

    // Handle arrays
    if (attribute.array) {
      baseSchemaCode = `z.array(${baseSchemaCode})`;
    }
    if (attribute.array && !attribute.required) {
      baseSchemaCode += ".nullish()";
    }

    return baseSchemaCode;
  };
}