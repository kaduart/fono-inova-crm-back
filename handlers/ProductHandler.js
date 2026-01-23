// handlers/ProductHandler.js
export class ProductHandler {
    async execute({ context, services }) {
        const { productService } = services;

        const product = await productService.resolve(context);

        return {
            data: {
                product
            }
        };
    }
}
